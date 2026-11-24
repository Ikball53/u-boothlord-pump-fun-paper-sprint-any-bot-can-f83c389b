// Quiet-launch momentum rider — pump.fun paper sprint bot.
//
// Idea: fresh pump.fun coins either ignite in their first minutes or fade.
// This bot watches every newborn coin, waits for a genuine breakout (price
// climbing on dominant buy volume with dispersed holders and a cheap
// creator fee), rides it with a small fixed stake, and banks the move in
// stages instead of hoping for one perfect exit. Every choice is a pure
// function of the events the harness has shown it so far: no clock, no
// randomness, no network — two replays of the same window agree exactly.
//
// How it talks to the harness (agent-fun/replay/v2):
//   hello  -> remember capital, caps and fees, say nothing.
//   batch  -> one reply line, {"type":"reply","seq":<same seq>,"orders":[...]}
//   done   -> stop quietly.
//
// Orders are buys in lamports (quote_lamports) and sells in raw token
// units (token_amount). A buy is capped at 0.8% of the coin's real SOL
// reserve so it always fits the harness's 100 bps order-size cap.

import * as readline from "node:readline";

const LAMPORTS_PER_SOL = 1_000_000_000n;

// ---- entry sizing -------------------------------------------------------
const TARGET_QUOTE = 200_000_000n; // 0.20 SOL staked per breakout
// Smallest entry: 0.012 SOL, just above the 0.01 SOL round-trip minimum.
// Fresh coins often hold only a few SOL of real reserves, so the 0.8%
// reserve cap shrinks the quote a lot — the floor must stay low or those
// breakouts get skipped entirely and the 20-coin minimum starves.
const MIN_QUOTE = 12_000_000n;
const QUOTE_BPS_OF_REAL = 80; // 0.8% of real SOL reserves, under the 100 cap
const CASH_BUFFER = 10_000_000n; // keep 0.01 SOL spare at all times

// ---- entry filters ------------------------------------------------------
const MAX_AGE_SLOTS = 2400; // only coins born in the last ~16 minutes
const BREAKOUT_RISE = 1.15; // +15% from the price first seen
const RECENT_RISE = 1.06; // still climbing over the last few batches
const NEAR_HIGH = 0.95; // price within 5% of its own high since birth
const MIN_BUY_VOLUME = 500_000_000n; // at least 0.5 SOL of buys so far
const BUY_DOMINANCE_NUM = 3n; // buy volume must be >= 1.5x sell volume
const BUY_DOMINANCE_DEN = 2n;
const MAX_TOP_HOLDER_BPS = 3000; // no single holder above 30%
const MAX_CREATOR_FEE_BPS = 200; // creator fee at most 2%
const REENTRY_COOLDOWN_SLOTS = 600; // wait 10 min before re-entering a coin

// ---- exit rules ---------------------------------------------------------
const STOP_LOSS = 0.75; // -25% from entry: out, no debate
const TAKE_ONE = 1.3; // +30%: bank 40% of the tokens
const TAKE_ONE_PCT = 40;
const TAKE_TWO = 1.8; // +80%: bank half of what is left
const TAKE_TWO_PCT = 50;
const TAKE_THREE = 2.6; // +160%: bank everything left
const TRAIL_ARM = 1.5; // trailing exit arms once +50% up
const TRAIL_GIVEBACK = 0.7; // out if price gives back 30% from its peak
const STALE_SLOTS = 9000; // close any trade older than ~1 hour
const DEAD_MONEY_SLOTS = 2400; // close an underwater trade after ~16 min

const MAX_SLIPPAGE_BPS = 300;
const SAMPLE_KEEP = 24; // price samples remembered per coin

// ---- small helpers ------------------------------------------------------
function toBig(value: string | undefined): bigint {
  if (value === undefined || value === "") return 0n;
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}

// Price of one raw token unit, in lamports: virtual SOL / virtual tokens.
// Only ratios of this number are ever compared, so the raw-unit scale
// cancels out and no decimal adjustment is needed.
function priceOf(solReserves: string, tokenReserves: string): number {
  const sol = Number(toBig(solReserves));
  const tok = Number(toBig(tokenReserves));
  if (tok <= 0 || sol < 0) return 0;
  return sol / tok;
}

function orderId(prefix: string, seq: number, n: number): string {
  return `${prefix}${seq}n${n}`;
}

// ---- per-coin memory ----------------------------------------------------
interface CoinBook {
  mint: string;
  bornSlot: number;
  firstPrice: number;
  lastPrice: number;
  highPrice: number;
  samples: Array<{ slot: number; price: number }>;
  buyVol: bigint;
  sellVol: bigint;
  topHolderBps: number; // -1 while unknown
  creatorFeeBps: number; // -1 while unknown
  completed: boolean;
  lastExitSlot: number; // -1 when never exited
  realQuote: bigint; // real SOL reserves from the latest mark
}

function newBook(mint: string, slot: number, price: number): CoinBook {
  return {
    mint,
    bornSlot: slot,
    firstPrice: price,
    lastPrice: price,
    highPrice: price,
    samples: [{ slot, price }],
    buyVol: 0n,
    sellVol: 0n,
    topHolderBps: -1,
    creatorFeeBps: -1,
    completed: false,
    lastExitSlot: -1,
    realQuote: 0n,
  };
}

function notePrice(book: CoinBook, slot: number, price: number): void {
  if (price <= 0) return;
  if (book.firstPrice <= 0) book.firstPrice = price;
  book.lastPrice = price;
  if (price > book.highPrice) book.highPrice = price;
  const last = book.samples[book.samples.length - 1];
  if (last === undefined || last.slot !== slot) {
    book.samples.push({ slot, price });
    if (book.samples.length > SAMPLE_KEEP) book.samples.shift();
  } else {
    last.price = price;
  }
}

// ---- our open trades ----------------------------------------------------
interface OpenTrade {
  mint: string;
  entrySlot: number;
  entryPrice: number;
  peakPrice: number;
  tookOne: boolean;
  tookTwo: boolean;
  closing: boolean; // a full-close sell is already in flight
}

interface Inflight {
  clientId: string;
  mint: string;
  kind: "buy" | "sell";
  quote: bigint; // lamports reserved (buys) or 0 (sells)
  tokens: bigint; // tokens committed (sells) or 0 (buys)
  fullClose: boolean;
}

type Order =
  | {
      side: "buy";
      client_id: string;
      mint: string;
      quote_lamports: string;
      max_slippage_bps: number;
    }
  | {
      side: "sell";
      client_id: string;
      mint: string;
      token_amount: string;
      max_slippage_bps: number;
    };

interface AccountPosition {
  mint: string;
  token_amount: string;
  cost_lamports: string;
}

class Rider {
  private books = new Map<string, CoinBook>();
  private trades = new Map<string, OpenTrade>();
  private inflight = new Map<string, Inflight>();
  private cash = 0n;
  private maxOpen = 5;
  private maxOrders = 16;
  private orderCounter = 0;

  hello(msg: any): void {
    this.cash = toBig(msg?.capital?.lamports);
    const caps = msg?.caps ?? {};
    if (typeof caps.max_open_positions === "number") {
      this.maxOpen = caps.max_open_positions;
    }
    if (typeof caps.max_orders_per_batch === "number") {
      this.maxOrders = caps.max_orders_per_batch;
    }
  }

  // One batch in, one reply out. Pure function of everything seen so far.
  decide(msg: any): Order[] {
    const slot: number = typeof msg.slot === "number" ? msg.slot : 0;
    const orders: Order[] = [];

    this.learnFromEvents(msg.events ?? [], slot);
    this.learnFromMarks(msg.marks ?? [], slot);
    this.learnFromFills(msg.fills ?? [], slot);
    this.reconcileAccount(msg.account ?? {}, slot);

    const positions = new Map<string, AccountPosition>();
    for (const p of msg.account?.positions ?? []) {
      positions.set(p.mint, p);
    }

    // Sells first: they free slots and lock in what the market gave us.
    this.planExits(slot, positions, orders);
    // Then entries, only while a slot and cash are actually free.
    this.planEntries(slot, positions, orders);

    return orders.slice(0, this.maxOrders);
  }

  // ---- learning ---------------------------------------------------------
  private learnFromEvents(events: any[], slot: number): void {
    for (const ev of events) {
      if (ev === null || typeof ev !== "object") continue;
      const mint: string | undefined = ev.mint;
      if (typeof mint !== "string") continue;

      if (ev.event === "CreateEvent") {
        if (!this.books.has(mint)) {
          const price = priceOf(ev.virtual_sol_reserves, ev.virtual_token_reserves);
          const book = newBook(mint, slot, price > 0 ? price : 0);
          book.creatorFeeBps = Number(toBig(ev.creator_fee_bps));
          this.books.set(mint, book);
        }
        continue;
      }

      if (ev.event === "CompleteEvent") {
        const book = this.books.get(mint);
        if (book !== undefined) book.completed = true;
        continue;
      }

      if (ev.event !== "TradeEvent") continue;
      let book = this.books.get(mint);
      const price = priceOf(ev.virtual_sol_reserves, ev.virtual_token_reserves);
      if (book === undefined) {
        book = newBook(mint, slot, price);
        this.books.set(mint, book);
      }
      const amount = toBig(ev.sol_amount);
      if (ev.is_buy === true) book.buyVol += amount;
      else book.sellVol += amount;
      notePrice(book, slot, price);
      if (Array.isArray(ev.shareholders) && ev.shareholders.length > 0) {
        let top = 0;
        for (const holder of ev.shareholders) {
          if (typeof holder?.share_bps === "number" && holder.share_bps > top) {
            top = holder.share_bps;
          }
        }
        book.topHolderBps = top;
      }
      const creatorBps = Number(toBig(ev.creator_fee_basis_points));
      if (creatorBps > 0) book.creatorFeeBps = creatorBps;
    }
  }

  private learnFromMarks(marks: any[], slot: number): void {
    for (const mark of marks) {
      if (mark === null || typeof mark !== "object") continue;
      const mint: string | undefined = mark.mint;
      if (typeof mint !== "string") continue;
      let book = this.books.get(mint);
      const price = priceOf(mark.virtual_quote_reserves, mark.virtual_token_reserves);
      if (book === undefined) {
        book = newBook(mint, slot, price);
        this.books.set(mint, book);
      }
      notePrice(book, slot, price);
      book.realQuote = toBig(mark.real_quote_reserves);
    }
  }

  private learnFromFills(fills: any[], slot: number): void {
    for (const fill of fills) {
      if (fill === null || typeof fill !== "object") continue;
      const flight = this.inflight.get(fill.client_id);
      if (flight === undefined) continue;
      this.inflight.delete(fill.client_id);

      if (fill.status === "filled") {
        if (flight.kind === "buy") {
          const tokens = toBig(fill.token_amount);
          const quote = toBig(fill.quote_lamports);
          const entryPrice = tokens > 0n ? Number(quote) / Number(tokens) : 0;
          if (entryPrice > 0) {
            const prev = this.trades.get(flight.mint);
            this.trades.set(flight.mint, {
              mint: flight.mint,
              entrySlot: typeof fill.decided_slot === "number" ? fill.decided_slot : slot,
              entryPrice,
              peakPrice: entryPrice,
              tookOne: prev?.tookOne ?? false,
              tookTwo: prev?.tookTwo ?? false,
              closing: false,
            });
          }
        } else if (flight.fullClose) {
          const trade = this.trades.get(flight.mint);
          if (trade !== undefined) {
            this.trades.delete(flight.mint);
            const book = this.books.get(flight.mint);
            if (book !== undefined) book.lastExitSlot = slot;
          }
        }
      } else {
        // Rejected or failed: a closing sell may be tried again next batch.
        if (flight.kind === "sell" && flight.fullClose) {
          const trade = this.trades.get(flight.mint);
          if (trade !== undefined) trade.closing = false;
        }
      }
    }
  }

  // The account is the truth about what we hold; adopt anything the fills
  // did not already explain (defensive only — it should not normally fire).
  private reconcileAccount(account: any, slot: number): void {
    if (typeof account?.cash_lamports === "string") {
      this.cash = toBig(account.cash_lamports);
    }
    for (const p of account?.positions ?? []) {
      if (p === null || typeof p !== "object") continue;
      const mint: string | undefined = p.mint;
      if (typeof mint !== "string") continue;
      const tokens = toBig(p.token_amount);
      const cost = toBig(p.cost_lamports);
      if (tokens <= 0n) {
        this.trades.delete(mint);
        continue;
      }
      if (!this.trades.has(mint) && !this.hasInflightBuy(mint)) {
        const entryPrice = Number(cost) / Number(tokens);
        if (entryPrice > 0) {
          this.trades.set(mint, {
            mint,
            entrySlot: slot,
            entryPrice,
            peakPrice: entryPrice,
            tookOne: false,
            tookTwo: false,
            closing: false,
          });
        }
      }
    }
    // Drop trades whose position vanished without a fill we saw.
    for (const mint of [...this.trades.keys()]) {
      const held = (account?.positions ?? []).some(
        (p: any) => p?.mint === mint && toBig(p.token_amount) > 0n,
      );
      if (!held && !this.hasInflightBuy(mint) && !this.hasInflightSell(mint)) {
        this.trades.delete(mint);
        const book = this.books.get(mint);
        if (book !== undefined) book.lastExitSlot = slot;
      }
    }
  }

  private hasInflightBuy(mint: string): boolean {
    for (const flight of this.inflight.values()) {
      if (flight.mint === mint && flight.kind === "buy") return true;
    }
    return false;
  }

  private hasInflightSell(mint: string): boolean {
    for (const flight of this.inflight.values()) {
      if (flight.mint === mint && flight.kind === "sell") return true;
    }
    return false;
  }

  private tokensCommitted(mint: string): bigint {
    let sum = 0n;
    for (const flight of this.inflight.values()) {
      if (flight.mint === mint && flight.kind === "sell") sum += flight.tokens;
    }
    return sum;
  }

  private cashCommitted(): bigint {
    let sum = 0n;
    for (const flight of this.inflight.values()) {
      if (flight.kind === "buy") sum += flight.quote;
    }
    return sum;
  }

  // ---- exits ------------------------------------------------------------
  private planExits(
    slot: number,
    positions: Map<string, AccountPosition>,
    orders: Order[],
  ): void {
    for (const trade of [...this.trades.values()]) {
      if (orders.length >= this.maxOrders) break;
      if (trade.closing) continue;
      const pos = positions.get(trade.mint);
      if (pos === undefined) continue;
      const held = toBig(pos.token_amount) - this.tokensCommitted(trade.mint);
      if (held <= 0n) continue;
      const book = this.books.get(trade.mint);
      const price = book?.lastPrice ?? 0;
      if (price <= 0) continue;
      if (price > trade.peakPrice) trade.peakPrice = price;

      const entry = trade.entryPrice;
      let sellPct = 0; // percent of the tokens still held
      let fullClose = false;

      if (book?.completed === true) {
        fullClose = true; // curve graduated: the bonding-curve game is over
      } else if (price <= entry * STOP_LOSS) {
        fullClose = true; // hard stop, no second guessing
      } else if (price >= entry * TAKE_THREE) {
        fullClose = true;
      } else if (!trade.tookOne && price >= entry * TAKE_ONE) {
        sellPct = TAKE_ONE_PCT;
        trade.tookOne = true;
      } else if (!trade.tookTwo && price >= entry * TAKE_TWO) {
        sellPct = TAKE_TWO_PCT;
        trade.tookTwo = true;
      } else if (
        trade.peakPrice >= entry * TRAIL_ARM &&
        price <= trade.peakPrice * TRAIL_GIVEBACK
      ) {
        fullClose = true; // rode it up, now it is giving the move back
      } else if (slot - trade.entrySlot > STALE_SLOTS) {
        fullClose = true; // held too long: free the slot for a fresh coin
      } else if (
        slot - trade.entrySlot > DEAD_MONEY_SLOTS &&
        price < entry
      ) {
        fullClose = true; // underwater and going nowhere
      }

      if (!fullClose && sellPct <= 0) continue;
      const amount = fullClose ? held : (held * BigInt(sellPct)) / 100n;
      if (amount <= 0n) continue;
      const id = orderId("s", slot, this.orderCounter++);
      orders.push({
        side: "sell",
        client_id: id,
        mint: trade.mint,
        token_amount: amount.toString(),
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      });
      this.inflight.set(id, {
        clientId: id,
        mint: trade.mint,
        kind: "sell",
        quote: 0n,
        tokens: amount,
        fullClose,
      });
      if (fullClose) trade.closing = true;
    }
  }

  // ---- entries ----------------------------------------------------------
  private planEntries(
    slot: number,
    positions: Map<string, AccountPosition>,
    orders: Order[],
  ): void {
    const openCount =
      positions.size +
      [...this.inflight.values()].filter((f) => f.kind === "buy").length -
      [...this.trades.values()].filter((t) => t.closing).length;
    if (openCount >= this.maxOpen) return;

    const freeCash = this.cash - this.cashCommitted() - CASH_BUFFER;
    if (freeCash < MIN_QUOTE) return;

    // Best breakout first: highest rise from its first-seen price.
    const candidates: Array<{ book: CoinBook; rise: number; quote: bigint }> = [];
    for (const book of this.books.values()) {
      if (book.completed) continue;
      if (this.trades.has(book.mint)) continue;
      if (this.hasInflightBuy(book.mint)) continue;
      if (slot - book.bornSlot > MAX_AGE_SLOTS) continue;
      if (
        book.lastExitSlot >= 0 &&
        slot - book.lastExitSlot < REENTRY_COOLDOWN_SLOTS
      ) {
        continue;
      }
      const price = book.lastPrice;
      if (price <= 0 || book.firstPrice <= 0) continue;
      const rise = price / book.firstPrice;
      if (rise < BREAKOUT_RISE) continue;
      if (price < book.highPrice * NEAR_HIGH) continue;
      if (book.samples.length >= 6) {
        const back = book.samples[book.samples.length - 6];
        if (back !== undefined && back.price > 0) {
          if (price / back.price < RECENT_RISE) continue;
        }
      }
      if (book.buyVol < MIN_BUY_VOLUME) continue;
      if (book.buyVol * BUY_DOMINANCE_DEN < book.sellVol * BUY_DOMINANCE_NUM) {
        continue;
      }
      if (book.topHolderBps > MAX_TOP_HOLDER_BPS) continue;
      if (book.creatorFeeBps >= 0 && book.creatorFeeBps > MAX_CREATOR_FEE_BPS) {
        continue;
      }
      let quote = TARGET_QUOTE;
      const capByReserve = (book.realQuote * BigInt(QUOTE_BPS_OF_REAL)) / 10000n;
      if (capByReserve < quote) quote = capByReserve;
      if (quote < MIN_QUOTE) continue;
      candidates.push({ book, rise, quote });
    }
    candidates.sort((a, b) => b.rise - a.rise);

    for (const pick of candidates) {
      if (orders.length >= this.maxOrders) break;
      if (openCount + orders.filter((o) => o.side === "buy").length >= this.maxOpen) {
        break;
      }
      const spent = orders
        .filter((o) => o.side === "buy")
        .reduce((sum, o) => sum + toBig(o.quote_lamports), 0n);
      if (freeCash - spent < pick.quote) continue;
      const id = orderId("b", slot, this.orderCounter++);
      orders.push({
        side: "buy",
        client_id: id,
        mint: pick.book.mint,
        quote_lamports: pick.quote.toString(),
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      });
      this.inflight.set(id, {
        clientId: id,
        mint: pick.book.mint,
        kind: "buy",
        quote: pick.quote,
        tokens: 0n,
        fullClose: false,
      });
    }
  }
}

// ---- wire loop ----------------------------------------------------------
async function main(): Promise<void> {
  const rider = new Rider();
  const lines = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    if (line.trim() === "") continue;
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      continue; // never let one bad line kill the run
    }
    if (msg?.type === "hello") {
      rider.hello(msg);
    } else if (msg?.type === "batch") {
      const orders = rider.decide(msg);
      const reply = JSON.stringify({
        type: "reply",
        seq: msg.seq,
        orders,
      });
      process.stdout.write(reply + "\n");
    } else if (msg?.type === "done") {
      break;
    }
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`rider failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
