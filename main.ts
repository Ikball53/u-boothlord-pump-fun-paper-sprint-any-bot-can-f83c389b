// Momentum Rider Paper Bot — pump.fun replay v2 (agent-fun/replay/v2)
//
// Strategy, in plain terms:
//   * Watch every new pump.fun launch. A coin only earns an entry when it
//     shows real early momentum: enough real SOL in the curve (about 1.35)
//     for a 0.012 SOL order to fit under the harness's 1%-of-reserves cap,
//     0.8 SOL of cumulative buy volume from 3+ distinct wallets, buys
//     beating sells. No gain hurdle: reaching that reserve level already
//     means ~+4% from launch on the bonding curve, and waiting for +10%
//     meant buying after the spike instead of before it.
//   * Filters keep us out of traps: skip coins whose creator fee is above
//     1% (every trade would bleed), skip extreme fee-shareholder
//     concentration, skip mayhem-mode coins and coins that already
//     graduated (CompleteEvent).
//   * Small size on purpose: 0.05 SOL per entry at most, capped at 0.9% of
//     the coin's real SOL reserves (the harness caps orders at 1%), and
//     never below 0.012 SOL so every round trip clears the 0.01 SOL bar.
//     At most 5 open positions, one entry per coin, so the book spreads
//     across 20+ coins instead of betting the window on one runner.
//   * Staged exits: sell half at +15%, sell the rest at +40%. The stop is
//     TIGHT at -2% from entry: most pump.fun coins dump right after their
//     spike, so losers are cut before the dump accelerates, and only the
//     few real runners pay — a 20% trailing drawdown from the peak banks
//     those. Any position older than ~2 hours is closed — never hold
//     through the whole window. Coins near graduation
//     (>= 70 SOL real reserves) are exited before they can strand us.
//
// The bot is fully deterministic: no clock, no randomness, no network.
// The same input always produces the same replies byte for byte.

import * as readline from "node:readline";

// ---- Tunables -------------------------------------------------------------

const TARGET_BUY_LAMPORTS = 50_000_000; // 0.05 SOL per entry
const MIN_BUY_LAMPORTS = 12_000_000; // 0.012 SOL, above the 0.01 bar
const MAX_ORDER_BPS_OF_REAL = 90; // harness cap is 100 bps; stay under it
const MAX_SLIPPAGE_BPS = 800;

const MIN_GAIN = 1.0; // no gain hurdle: reaching 1.35 SOL of real reserves IS
// the momentum — on the bonding curve that already means ~+4% from launch.
// Waiting for +10% meant buying after the spike, not before it.
const MIN_BUY_VOL_LAMPORTS = 800_000_000; // 0.8 SOL of buys
const MIN_BUY_COUNT = 3;
const MIN_DISTINCT_BUYERS = 3;
const BUY_SELL_RATIO = 1.2; // buys must beat sells — light, the size gate does the work
const MAX_ENTRY_AGE_SLOTS = 6000; // ~40 min after launch: enter near the
// 1.35-SOL moment, not hours later when the spike is already over
const MAX_CREATOR_FEE_BPS = 100; // 1% — above this, fees eat the trade
const MAX_TOP_SHARE_BPS = 8000; // skip extreme fee-share concentration
const GRAD_REAL_SOL_LAMPORTS = 70_000_000_000; // exit before graduation

const TP1_RATIO = 1.15; // sell half — modest first target; big targets rarely
// survive to end-of-slot prices, so bank the first leg early
const TP2_RATIO = 1.4; // sell the rest
const STOP_RATIO = 0.98; // tight stop: cut at -2% before the dump accelerates
const TRAIL_DRAWDOWN = 0.2; // 20% off the peak since entry
const MAX_HOLD_SLOTS = 20000; // ~2.2 h, then close no matter what

// ---- Types ----------------------------------------------------------------

interface Coin {
  mint: string;
  firstSlot: number;
  firstPrice: number; // SOL per token at first sight
  lastPrice: number;
  realSol: number; // lamports
  buyVol: number; // lamports, cumulative
  sellVol: number; // lamports, cumulative
  buyCount: number;
  buyers: Set<string>;
  creatorFeeBps: number;
  topShareBps: number;
  completed: boolean;
  mayhem: boolean;
}

interface Position {
  mint: string;
  tokens: bigint;
  entryPrice: number; // SOL per token (avg cost)
  entrySlot: number;
  peakRatio: number; // best price/entryPrice seen since entry
  tp1Taken: boolean;
}

interface Order {
  side: "buy" | "sell";
  client_id: string;
  mint: string;
  quote_lamports?: string;
  token_amount?: string;
  max_slippage_bps: number;
}

// ---- State ----------------------------------------------------------------

let maxOpenPositions = 5;
let maxOrdersPerBatch = 16;
let cashLamports = 0;

const coins = new Map<string, Coin>();
const positions = new Map<string, Position>();
const enteredBefore = new Set<string>();
const pendingBuys = new Set<string>();
const pendingSells = new Map<string, bigint>(); // tokens with a sell in flight
// Market entry price per mint from the buy fill itself (curve quote paid,
// fees stripped out): the account's cost basis includes fees, which would
// shift a tight -2% stop by ~+3% and trip it on noise. Filled buys only.
const entryMarketPrice = new Map<string, number>();
let orderCounter = 0;

function priceOf(virtualQuote: string, virtualToken: string): number {
  const q = Number(virtualQuote);
  const t = Number(virtualToken);
  if (t <= 0) return 0;
  return q / t;
}

function getCoin(mint: string, slot: number, price: number): Coin {
  let c = coins.get(mint);
  if (!c) {
    c = {
      mint,
      firstSlot: slot,
      firstPrice: price,
      lastPrice: price,
      realSol: 0,
      buyVol: 0,
      sellVol: 0,
      buyCount: 0,
      buyers: new Set<string>(),
      creatorFeeBps: 0,
      topShareBps: 0,
      completed: false,
      mayhem: false,
    };
    coins.set(mint, c);
  }
  return c;
}

function nextClientId(prefix: string, mint: string): string {
  orderCounter += 1;
  return `${prefix}-${orderCounter}-${mint.slice(0, 8)}`;
}

// ---- Batch processing -----------------------------------------------------

function processEvents(msg: any, slot: number): void {
  const events = msg.events as any[];
  for (const ev of events) {
    if (ev.event === "CreateEvent") {
      const p = priceOf(ev.virtual_sol_reserves, ev.virtual_token_reserves);
      const c = getCoin(ev.mint, slot, p);
      c.creatorFeeBps = Number(ev.creator_fee_bps);
      if (ev.is_mayhem_mode) c.mayhem = true;
      c.realSol = 0;
    } else if (ev.event === "TradeEvent") {
      const p = priceOf(ev.virtual_quote_reserves, ev.virtual_token_reserves);
      const c = getCoin(ev.mint, slot, p);
      c.lastPrice = p;
      c.realSol = Number(ev.real_sol_reserves);
      if (ev.mayhem_mode) c.mayhem = true;
      const feeBps = Number(ev.creator_fee_basis_points);
      if (feeBps > c.creatorFeeBps) c.creatorFeeBps = feeBps;
      const shares = ev.shareholders as any[];
      if (Array.isArray(shares)) {
        for (const s of shares) {
          if (s.share_bps > c.topShareBps) c.topShareBps = s.share_bps;
        }
      }
      const sol = Number(ev.sol_amount);
      if (ev.is_buy) {
        c.buyVol += sol;
        c.buyCount += 1;
        c.buyers.add(ev.user);
      } else {
        c.sellVol += sol;
      }
    } else if (ev.event === "CompleteEvent") {
      const c = coins.get(ev.mint);
      if (c) c.completed = true;
    }
  }
}

function processMarks(msg: any, slot: number): void {
  const marks = msg.marks as any[];
  if (!Array.isArray(marks)) return;
  for (const m of marks) {
    const p = priceOf(m.virtual_quote_reserves, m.virtual_token_reserves);
    const c = getCoin(m.mint, slot, p);
    c.lastPrice = p;
    c.realSol = Number(m.real_quote_reserves);
  }
}

function processFills(msg: any): void {
  const fills = msg.fills as any[];
  if (!Array.isArray(fills)) return;
  for (const f of fills) {
    if (f.side === "sell") {
      // A sell resolved either way: the account sync is the truth from here.
      pendingSells.delete(f.mint);
      continue;
    }
    if (f.side !== "buy") continue;
    if (f.status === "filled") {
      // Buy landed: the mint is now a real position, no longer pending.
      pendingBuys.delete(f.mint);
      // Remember the market price actually paid (fees stripped) so the
      // tight stop measures the market, not the fee-loaded cost basis.
      const quote = Number(f.quote_lamports);
      const fee = Number(f.fee_lamports);
      const toks = BigInt(f.token_amount as string);
      if (toks > 0n && quote > fee) {
        entryMarketPrice.set(f.mint, (quote - fee) / Number(toks));
      }
    } else if (f.status === "rejected" || f.status === "failed") {
      // Buy did not land: free the coin for a later retry.
      pendingBuys.delete(f.mint);
      enteredBefore.delete(f.mint);
    }
  }
}

function syncPositions(msg: any, slot: number): void {
  // account.positions is authoritative: rebuild token balances from it,
  // keeping our own entry metadata keyed by mint.
  const acct = msg.account as any;
  const seen = new Set<string>();
  const list = (acct && Array.isArray(acct.positions) ? acct.positions : []) as any[];
  for (const p of list) {
    const mint = p.mint as string;
    const tokens = BigInt(p.token_amount as string);
    const cost = Number(p.cost_lamports as string);
    seen.add(mint);
    pendingBuys.delete(mint); // belt-and-braces: a held mint is not pending
    const existing = positions.get(mint);
    if (existing) {
      existing.tokens = tokens;
      if (tokens === 0n) {
        positions.delete(mint);
        entryMarketPrice.delete(mint);
      }
    } else if (tokens > 0n) {
      const costPrice = tokens > 0n ? cost / Number(tokens) : 0;
      // Prefer the market price from the buy fill; fall back to cost basis.
      const entryPrice = entryMarketPrice.get(mint) ?? costPrice;
      positions.set(mint, {
        mint,
        tokens,
        entryPrice: entryPrice > 0 ? entryPrice : 0,
        entrySlot: slot,
        peakRatio: 1,
        tp1Taken: false,
      });
    }
  }
  for (const mint of [...positions.keys()]) {
    if (!seen.has(mint)) positions.delete(mint);
  }
  if (acct && typeof acct.cash_lamports === "string") {
    cashLamports = Number(acct.cash_lamports);
  }
}

// ---- Decisions ------------------------------------------------------------

function decideExits(slot: number, orders: Order[]): void {
  for (const pos of [...positions.values()]) {
    // Tokens already covered by a sell order still in flight are not
    // available to sell again — sending them twice only earns rejections.
    const inFlight = pendingSells.get(pos.mint) ?? 0n;
    const available = pos.tokens - inFlight;
    if (available <= 0n) continue;
    const coin = coins.get(pos.mint);
    const price = coin ? coin.lastPrice : pos.entryPrice;
    if (pos.entryPrice <= 0 || price <= 0) continue;
    const ratio = price / pos.entryPrice;
    if (ratio > pos.peakRatio) pos.peakRatio = ratio;

    // A completed (graduated) coin rejects sells with token_complete, so
    // never spend an order slot on one — the position is stranded and the
    // harness will write it off; just leave it alone.
    if (coin && coin.completed) continue;

    let sellAll = false;
    let sellHalf = false;
    if (ratio >= TP2_RATIO) sellAll = true;
    else if (ratio >= TP1_RATIO && !pos.tp1Taken) sellHalf = true;
    else if (ratio <= STOP_RATIO) sellAll = true;
    else if (pos.peakRatio - ratio >= TRAIL_DRAWDOWN) sellAll = true;
    else if (slot - pos.entrySlot >= MAX_HOLD_SLOTS) sellAll = true;
    else if (coin && coin.realSol >= GRAD_REAL_SOL_LAMPORTS) sellAll = true;

    if (sellAll) {
      pendingSells.set(pos.mint, (pendingSells.get(pos.mint) ?? 0n) + available);
      orders.push({
        side: "sell",
        client_id: nextClientId("s", pos.mint),
        mint: pos.mint,
        token_amount: available.toString(),
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      });
    } else if (sellHalf) {
      const half = available / 2n;
      if (half > 0n) {
        pos.tp1Taken = true;
        pendingSells.set(pos.mint, (pendingSells.get(pos.mint) ?? 0n) + half);
        orders.push({
          side: "sell",
          client_id: nextClientId("s", pos.mint),
          mint: pos.mint,
          token_amount: half.toString(),
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        });
      }
    }
  }
}

function decideEntries(slot: number, orders: Order[]): void {
  const freeSlots = maxOpenPositions - positions.size - pendingBuys.size;
  if (freeSlots <= 0) return;
  if (orders.length >= maxOrdersPerBatch) return;

  const candidates: Coin[] = [];
  for (const c of coins.values()) {
    if (positions.has(c.mint)) continue;
    if (pendingBuys.has(c.mint)) continue;
    if (enteredBefore.has(c.mint)) continue;
    if (c.completed || c.mayhem) continue;
    if (c.firstPrice <= 0 || c.lastPrice <= 0) continue;
    if (slot - c.firstSlot > MAX_ENTRY_AGE_SLOTS) continue;
    if (c.lastPrice / c.firstPrice < MIN_GAIN) continue;
    if (c.buyVol < MIN_BUY_VOL_LAMPORTS) continue;
    if (c.buyCount < MIN_BUY_COUNT) continue;
    if (c.buyers.size < MIN_DISTINCT_BUYERS) continue;
    if (c.buyVol < BUY_SELL_RATIO * c.sellVol) continue;
    if (c.creatorFeeBps > MAX_CREATOR_FEE_BPS) continue;
    if (c.topShareBps > MAX_TOP_SHARE_BPS) continue;
    // Size: at most 0.9% of real reserves, at least 0.012 SOL.
    const sized = Math.min(
      TARGET_BUY_LAMPORTS,
      Math.floor((c.realSol * MAX_ORDER_BPS_OF_REAL) / 10000),
    );
    if (sized < MIN_BUY_LAMPORTS) continue;
    if (cashLamports < sized + 500_000) continue;
    candidates.push(c);
  }

  // Deterministic order: nearest the entry threshold first. The edge is
  // entering right when a coin first reaches ~1.35 SOL of real reserves
  // (about +4% from launch); sorting by biggest gain instead would pick
  // the coins that already pumped the most — the ones likeliest to dump
  // next. Smallest real reserves first, mint as tiebreak.
  candidates.sort((a, b) => {
    if (a.realSol !== b.realSol) return a.realSol - b.realSol;
    return a.mint < b.mint ? -1 : a.mint > b.mint ? 1 : 0;
  });

  for (const c of candidates) {
    if (positions.size + pendingBuys.size >= maxOpenPositions) break;
    if (orders.length >= maxOrdersPerBatch) break;
    const sized = Math.min(
      TARGET_BUY_LAMPORTS,
      Math.floor((c.realSol * MAX_ORDER_BPS_OF_REAL) / 10000),
    );
    if (sized < MIN_BUY_LAMPORTS) continue;
    if (cashLamports < sized + 500_000) continue;
    cashLamports -= sized;
    enteredBefore.add(c.mint);
    pendingBuys.add(c.mint);
    orders.push({
      side: "buy",
      client_id: nextClientId("b", c.mint),
      mint: c.mint,
      quote_lamports: String(sized),
      max_slippage_bps: MAX_SLIPPAGE_BPS,
    });
  }
}

// ---- Main loop ------------------------------------------------------------

async function main(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.type === "hello") {
      if (msg.caps) {
        if (typeof msg.caps.max_open_positions === "number") {
          maxOpenPositions = msg.caps.max_open_positions;
        }
        if (typeof msg.caps.max_orders_per_batch === "number") {
          maxOrdersPerBatch = msg.caps.max_orders_per_batch;
        }
      }
      if (msg.capital && typeof msg.capital.lamports === "string") {
        cashLamports = Number(msg.capital.lamports);
      }
      continue;
    }
    if (msg.type === "done") {
      break;
    }
    if (msg.type !== "batch") continue;

    const slot = typeof msg.slot === "number" ? msg.slot : 0;
    processEvents(msg, slot);
    processMarks(msg, slot);
    processFills(msg);
    syncPositions(msg, slot);

    const orders: Order[] = [];
    decideExits(slot, orders);
    decideEntries(slot, orders);

    const reply = { type: "reply", seq: msg.seq, orders };
    process.stdout.write(JSON.stringify(reply) + "\n");
  }
}

main().catch(() => {
  process.exit(1);
});
