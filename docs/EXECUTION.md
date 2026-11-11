# Execution model, accounting and fidelity limits

## Fills (causal)

- An order may only use market events whose timestamp is **≥ acceptance + latency** (default 250 ms). A modification is a cancel/replace, so the replacement gets a new acceptance time.
- **Buys execute against the ask, sells against the bid.** A last trade is never used as an execution price.
- The quote must be **live**: received on a stream that has stayed connected since. REST snapshots are display-only and never fill anything. A quote older than *max quote age* (default 120 s) or with a spread wider than *max spread* (5%) is not executable.
- Price = touch ± slippage (default 2 bps), capped at the limit price. Quantity per event = displayed size × size multiplier (default 1). Larger orders fill over several quotes (partial fills). No queue position is modeled.
- **Stops** (incl. trailing) trigger when the bid (sell) / ask (buy) or a trade reaches the stop (configurable basis), then fill no earlier than the *next* eligible quote after latency, so gaps fill at the gapped price. A stop-limit can trigger and stay unfilled.
- **Trailing** stops ratchet a high-water (sell) / low-water (buy) mark from eligible prices only; the trail restarts on modification.
- **IOC** fills what is available on the first eligible quote and cancels the rest; **FOK** and **AON** require the whole remaining quantity in one quote (FOK cancels, AON waits). IOC/FOK with no eligible quote within 10 s are canceled.
- **OCO**: any fill on one leg cancels the others in the same database transaction; events are processed one at a time, so two legs can never both fill. **OTO/OTOCO** exits activate on the primary's first fill, sized to the filled quantity, and grow as it fills more. Canceling an unfilled primary cancels its exits.
- **Contingent** orders become active when the condition holds on live data newer than the order; activation time = that event's time.
- Funds/positions are re-checked at execution; if prices moved and the account can no longer afford it, the order is rejected (or the remainder canceled) with the reason recorded.
- Every fill stores the exact quote used and the model parameters. Fill ids are derived from (order, event), so replayed events after a reconnect or restart are never applied twice.

## Sessions & time

NYSE calendar 2026–2028 (holidays, 1 pm early closes, DST via `America/New_York`). Regular orders wait for 9:30–16:00 ET; extended-hours orders (limit, DAY) can only be entered and filled in the pre (7:00–9:28) or after-hours (16:00–20:00) session they were entered in. DAY orders expire at the close; GTC after 180 days. Crypto and DEMO instruments trade 24/7. Beyond 2028 trading is blocked until the calendar is updated.

## Gaps, sleep, outages

The engine runs only while the service runs. Stream disconnects, service stops and computer sleep (detected as a >15 s heartbeat jump) are recorded as **monitoring gaps**, shown in the status bar and on each affected order. Every quote received before a gap stops being live. **No fills are reconstructed for gaps**: orders wait for fresh data. Trailing marks may have missed highs/lows during a gap, and the order history says so.

## Valuation vs. execution

Positions are **marked** at the quote midpoint (else last trade, else previous close, flagged *stale*). Execution uses bid/ask as above. The mark is therefore slightly better than what a sale would receive.

## Accounting

- Decimal arithmetic (decimal.js) throughout; cash postings are rounded to cents per transaction.
- An auditable ledger holds starting capital, deposits/withdrawals (external flows), trades, fees, margin interest, borrow fees, dividends and split adjustments. Cash = sum of the ledger.
- **FIFO lots.** Each closing order is one counted trade. Net P&L = gross lot P&L − the opening fees allocated to the closed quantity − closing fees.
- **Cash account**: sale proceeds settle T+1 (crypto treated as immediate). You may buy with unsettled proceeds; selling such a purchase before settlement is a good faith violation (3 in 12 months → 90-day settled-cash-only restriction).
- **Margin account**: equity = cash + long value − short value. Short proceeds are collateral: they are excluded from free cash and from buying power. Buying power ≈ (equity − initial requirement − requirement reserved for open orders) ÷ 50% for marginable stock. This is an approximation of Fidelity's calculation (SMA history is not modeled). Maintenance deficiencies are flagged as a margin call and block opening orders; **no forced liquidation is simulated**.
- Reservations: open buys reserve estimated cost (limit price, or ask + 2% for market/stop); sells reserve shares; OCO legs reserve once; inactive OTO exits reserve nothing.
- Daily margin interest (tiered rate / 360) and borrow fees post for each completed day, using the balance at posting time. Days when the service was off are posted on the next start (estimate).
- Corporate actions (Alpaca): splits adjust lot quantity/price and cancel open orders on the symbol; cash dividends credit longs (debit shorts) on the payable date. If the check fails, the status bar shows "unverified"; actions that cannot be applied block trading in that symbol.
- Performance: daily P&L and the time-weighted return exclude external flows. Benchmarks buy the ETF with each deposit at that day's close (price return = split-adjusted; total return ≈ split+dividend-adjusted).

## Known fidelity limits

IEX-only quotes (not NBBO), no depth, no queue position, no hidden/odd-lot liquidity, no auctions/opening cross, no halts/LULD handling, no borrow availability (assumed easy to borrow; hard-to-borrow symbols blocked), no forced liquidation, no wash-sale or tax handling, no options/futures/forex/bonds/mutual funds. All estimated values are labeled in the UI.
