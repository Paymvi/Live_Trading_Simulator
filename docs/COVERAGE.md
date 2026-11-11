# Data & market coverage matrix

Checked **2026-11-10**. Free plans change; re-check the links before relying on any row.

## Chosen setup

**One provider: Alpaca Market Data, free "Basic" plan.** It is the only free option found with *documented* real-time streaming of both stocks/ETFs and crypto, a REST history endpoint, an asset list and a corporate-actions endpoint, under one key. Alternatives were not worth a second integration:

| Candidate | Finding (2026-11-10) | Decision |
|---|---|---|
| Alpaca Basic | Real-time IEX quotes+trades, 30 streamed symbols, 1 stream connection per key, 200 REST calls/min, SIP history only when ≥15 min old, indicative (not OPRA) options, crypto real-time | **Used** |
| Finnhub free | Third-party sources conflict (50-symbol trade stream vs. 15-min delayed); official pricing page not confirmed; trades only, no bid/ask on free stream | Not used: no verified executable quotes |
| Tiingo IEX | Free personal-use IEX top-of-book WebSocket exists; same IEX-only limitation as Alpaca; no crypto/corp-actions advantage verified | Not used: no coverage gain |
| Twelve Data free | WebSocket only as a "trial"; full access needs Pro (paid) | Not used |
| Polygon/Massive, Algo Trader Plus, OPRA | Paid | Excluded (no purchases) |

## Matrix

| Asset class | Data source | Cost | Signup | Update frequency | Delay | Simulated execution | Main limitations |
|---|---|---|---|---|---|---|---|
| **US stocks & ETFs** | Alpaca IEX stream (`wss://stream.data.alpaca.markets/v2/iex`); SIP bars via REST | $0 | Free Alpaca account + paper API key (no funding) | Every IEX quote/trade change | Real-time (IEX); charts ≥15 min delayed | **Yes**: all order types below, cash & margin, long/short, fractional (eligible symbols), extended hours | IEX is a small share of US volume: quotes are **not the NBBO**; displayed size is IEX-only; 30 streamed symbols (open orders/positions get priority); history misses the latest 15 min |
| **Crypto** (USD pairs) | Alpaca crypto stream (`/v1beta3/crypto/us`) & REST | $0 | Same key | Every quote/trade | Real-time | **Yes**: market & limit, GTC/IOC, cash only, 1% fee (Fidelity Crypto) | Quotes are Alpaca's own venue, not the venues Fidelity routes to; top-of-book size there is very small (≈0.001 BTC), so fills are conservative unless you raise the size multiplier |
| **Options** | Alpaca free = *indicative* feed (MsgPack only) | $0 | Same key | — | Indicative | **No** | Indicative prices are not executable quotes; needs OPRA (Alpaca Algo Trader Plus, $99/mo) or another licensed OPRA feed |
| **Futures** | None free & real-time found | — | — | — | — | **No** | Needs a CME data license/vendor; Fidelity retail does not offer futures (Fidelity Crypto FAQ: futures not offered) |
| **Forex** | No free verified real-time bid/ask stream | — | — | — | — | **No** | Needs a forex quote feed; Fidelity does not offer spot FX trading to retail |
| **Bonds** | No free quote source | — | — | — | — | **No** | Needs TRACE/dealer quotes (paid); bond pricing/accrued interest would need its own model |
| **Mutual funds** | Not in Alpaca free data | — | — | Once a day (NAV) | — | **No** | Needs a NAV source (end-of-day); orders execute at next NAV, so a daily batch model would be needed |
| **DEMO instruments** (`DEMO-*`) | Built-in synthetic random walk | $0 | None | 1 s | n/a | Yes, **demo accounts only** | Not market data; labeled DEMO everywhere; never mixed with live accounts |

Other data used: Alpaca `/v1/corporate-actions` (cash dividends, forward/reverse splits) and `paper-api.alpaca.markets/v2/assets` (symbol list, marginable/shortable/fractionable flags). The app never calls order endpoints (enforced by a lint rule). Alpaca's terms PDF was not reviewed in detail; the app only displays data locally to you and does not redistribute it.

## Sources

- Alpaca plans/feeds: https://docs.alpaca.markets/us/docs/about-market-data-api
- Alpaca FAQ (IEX free, SIP ≥15 min): https://docs.alpaca.markets/us/docs/market-data-faq
- Alpaca streaming (1 connection, message formats): https://docs.alpaca.markets/docs/streaming-market-data , https://docs.alpaca.markets/us/docs/real-time-stock-pricing-data
- Alpaca crypto / options streams: https://docs.alpaca.markets/docs/real-time-crypto-pricing-data , https://docs.alpaca.markets/docs/real-time-option-data
- Alpaca corporate actions / assets: https://docs.alpaca.markets/reference/corporateactions-1 , https://docs.alpaca.markets/reference/get-v2-assets-1
- Twelve Data WebSocket trial: https://support.twelvedata.com/en/articles/5335783-trial
- Tiingo IEX WebSocket: https://api.tiingo.com/docs/iex/realtime

## Brokerage rules (Fidelity reference), checked 2026-11-10

| Rule | Value used | Source |
|---|---|---|
| Stock/ETF commission | $0 | https://www.fidelity.com/trading/commissions-margin-rate |
| Crypto fee | 1% of executed value | https://www.fidelity.com/crypto/help/trading/trading-fees |
| Margin rate | Base 10.825% (eff. 2026-09-18) with debit tiers; day count 360 = **estimate** | commissions-margin-rate page |
| Margin requirements | $2,000 min equity; Reg T 50% initial; house 30% long / 35% short; ≤$3 = 100%, $3–10 = max(30%, $3/share) | https://www.fidelity.com/trading/faqs-margin |
| Cash account | T+1 settlement; good faith violation; 3 GFVs in 12 months → 90-day settled-cash restriction | https://www.fidelity.com/trading/faqs-trading-restrictions |
| Extended hours | Pre 7:00–9:28, after 16:00–20:00 ET; limit orders only; expire at session end | https://www.fidelity.com/viewpoints/active-investor/extended-hours-trading |
| Conditional orders | OCO, OTO, OTOCO, contingent, multi-contingent; trailing stops allowed in legs | https://www.fidelity.com/learning-center/trading-investing/trading/conditional-order-types |
| Day trading | PDT rule replaced by FINRA intraday margin, effective 2026-06-04 | https://www.finra.org/compliance-tools/weekly-archive/04152026 |
| SEC Section 31 fee | $20.60 per $1M of sales (from 2026-04-04); rounding = **estimate** | https://www.sec.gov/rules-regulations/fee-rate-advisories/2026-2 |
| FINRA TAF | $0.000166/share, max $8.30; paused 2026-10-01 → 12-31 per filing (**not independently confirmed**) | https://www.finra.org/finramanual/org/bylaws_A_1/ , https://www.finra.org/rules-guidance/rule-filings/sr-finra-2026-021 |
| NYSE calendar | 2026–2028 holidays and 1 pm early closes | https://ir.theice.com/press/news-details/2025/NYSE-Group-Announces-2026-2027-and-2028-Holiday-and-Early-Closings-Calendar/default.aspx |

**Not verified / estimated (labeled in the app):** Fidelity trailing-stop trigger basis (bid/ask vs. last), low-priced *short* requirements (shorts under $5 are therefore blocked), borrow fees (assumed 0.5%/yr), after-hours end on early-close days (17:00 assumed), interest day count, regulatory-fee rounding, and whether Fidelity passes the TAF through.
