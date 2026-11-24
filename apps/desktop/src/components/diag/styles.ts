/**
 * Styles for the scan-tool flow (Auto Diagnostic), in the B1 "Classic" look.
 * Mounted once by DiagnosticsTab; it sits inside the Universal Auto Lab shell, so the
 * --ual-* palette from src/shell/theme.css is available here.
 */
export const diagStyles = `
.dg { display: flex; flex-direction: column; min-height: 100%; }

/* path bar — where you are inside Auto Diagnostic and how to get back */
.dg-bar { display: flex; align-items: center; gap: 8px; padding: 10px 28px; min-height: 52px; border-bottom: 1px solid var(--ual-line); background: var(--ual-bg); }
.ual .dg-bar .dg-nav { min-height: 34px; padding: 0 10px; display: inline-flex; align-items: center; color: var(--ual-neutral-ink); }
.dg-path { display: flex; align-items: center; gap: 4px; font-size: 13.5px; color: var(--ual-muted); flex-wrap: wrap; }
.dg-path b { color: var(--ual-ink); font-weight: 600; }
.dg-path .sep { color: #a3a8a0; }
.ual .dg-path button { background: none; border: none; min-height: 0; padding: 2px 4px; color: var(--ual-muted); font-size: 13.5px; font-weight: 500; }
.ual .dg-path button:hover:not(:disabled) { background: none; color: var(--ual-blue); }
.dg-spacer { flex: 1; }
.dg-chip { font-size: 11px; font-weight: 700; letter-spacing: .04em; padding: 3px 9px; border-radius: 999px; background: var(--ual-prot-tint); color: var(--ual-prot-ink); white-space: nowrap; }
.dg-chip.demo { background: var(--ual-blue-tint); color: var(--ual-blue-ink); }
.dg-in { font-family: var(--ual-code); }

.dg-body { flex: 1; padding: 24px 28px 32px; width: 100%; max-width: 1600px; margin: 0 auto; box-sizing: border-box; }
.dg-h { margin: 0 0 4px; font-family: var(--ual-display); font-size: 28px; font-weight: 700; letter-spacing: -0.01em; }
.dg-sub { color: var(--ual-muted); font-size: 14px; margin: 0 0 18px; max-width: 760px; }
.dg-note { margin: 0 0 14px; padding: 10px 14px; border-radius: 12px; border: 1px solid var(--ual-line); background: var(--ual-surface); font-size: 13.5px; }
.dg-note.warn { border-color: var(--ual-prot-line); background: #fffbeb; }
.dg-note.err { border-color: var(--ual-fault-line); background: var(--ual-fault-soft); }
.dg-note.ok { border-color: #99e6d8; background: #effcf8; }

/* big entry tiles (home, service) */
.dg-tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 14px; margin-bottom: 22px; }
.ual .dg-tile { display: flex; flex-direction: column; align-items: flex-start; gap: 6px; text-align: left; min-height: 150px; padding: 18px 20px; border-radius: 18px; background: var(--ual-surface); border: 1px solid var(--ual-line); font-weight: 400; }
.ual .dg-tile:hover:not(:disabled) { border-color: var(--ual-blue-line); background: var(--ual-surface); box-shadow: 0 2px 12px rgba(20,23,26,.06); }
.dg-tile .ico { width: 44px; height: 44px; border-radius: 12px; background: var(--ual-soft); color: var(--ual-neutral-ink); display: flex; align-items: center; justify-content: center; margin-bottom: 4px; }
.dg-tile .t { font-family: var(--ual-display); font-size: 18px; font-weight: 700; }
.dg-tile .d { font-size: 13px; color: var(--ual-muted); line-height: 1.45; }
.ual .dg-tile.hot { border: 2px solid var(--ual-blue); }
.dg-tile.hot .ico { background: var(--ual-blue); color: #fff; }
.dg-tile .cnt { margin-top: auto; font-size: 12px; color: var(--ual-blue-ink); font-weight: 600; }

/* make / model pickers */
.dg-brands { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 10px; }
.ual .dg-brand { min-height: 76px; display: flex; flex-direction: column; justify-content: center; align-items: flex-start; gap: 4px; padding: 12px 16px; border-radius: 14px; background: var(--ual-surface); border: 1px solid var(--ual-line); font-family: var(--ual-display); font-size: 16px; font-weight: 700; text-align: left; }
.dg-brand small { font-family: var(--ual-sans); font-size: 12px; font-weight: 500; color: var(--ual-muted); }
.ual .dg-brand.has { border-color: var(--ual-blue-line); }
.dg-brand.has small { color: var(--ual-blue-ink); }
.dg-list { display: flex; flex-direction: column; gap: 8px; }
.ual .dg-item { display: flex; align-items: center; gap: 14px; text-align: left; padding: 14px 18px; border-radius: 14px; background: var(--ual-surface); border: 1px solid var(--ual-line); width: 100%; font-weight: 400; }
.ual .dg-item:hover:not(:disabled) { border-color: var(--ual-blue-line); background: var(--ual-surface); }
.dg-item .main { flex: 1; min-width: 0; }
.dg-item .main b { display: block; font-size: 15px; }
.dg-item .main small { color: var(--ual-muted); font-size: 12.5px; }
.dg-item .chev { color: var(--ual-muted); display: flex; }
.dg-form { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-top: 14px; }
.dg-form input { width: auto; }
.dg-cat { font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: .08em; color: var(--ual-muted); margin: 18px 0 8px; }

/* header card (system page) */
.dg-veh { display: flex; gap: 22px; align-items: center; padding: 18px 22px; border-radius: 18px; background: var(--ual-surface); border: 1px solid var(--ual-line); margin-bottom: 16px; flex-wrap: wrap; }
.dg-veh .name { font-family: var(--ual-display); font-size: 24px; font-weight: 700; line-height: 1.2; }
.dg-veh .meta { color: var(--ual-muted); font-size: 13px; margin-top: 4px; max-width: 760px; }
.dg-veh .kv { display: flex; flex-direction: column; gap: 2px; font-size: 11px; color: var(--ual-muted); text-transform: uppercase; letter-spacing: .06em; font-weight: 600; }
.dg-veh .kv b { font-size: 14px; color: var(--ual-ink); text-transform: none; letter-spacing: 0; font-family: var(--ual-code); font-weight: 500; }

/* function menu inside a system */
.dg-fns { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 12px; margin-bottom: 16px; }
.ual .dg-fn { min-height: 128px; display: flex; flex-direction: column; align-items: flex-start; gap: 5px; text-align: left; padding: 14px 16px; border-radius: 16px; background: var(--ual-surface); border: 1px solid var(--ual-line); font-weight: 400; }
.ual .dg-fn:hover:not(:disabled) { border-color: var(--ual-blue-line); background: var(--ual-surface); }
.ual .dg-fn.on { border: 2px solid var(--ual-blue); background: var(--ual-surface); }
.dg-fn .ico { width: 38px; height: 38px; border-radius: 10px; background: var(--ual-soft); color: var(--ual-neutral-ink); display: flex; align-items: center; justify-content: center; }
.dg-fn.on .ico { background: var(--ual-blue-tint); color: var(--ual-blue); }
.dg-fn .t { font-size: 15px; font-weight: 700; }
.dg-fn .d { font-size: 12.5px; color: var(--ual-muted); line-height: 1.4; }
.dg-fn .tag { margin-top: auto; font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 999px; background: var(--ual-neutral-tint); color: var(--ual-neutral-ink); }
.dg-fn .tag.yes { background: var(--ual-clean-tint); color: var(--ual-clean-ink); }
.dg-fn .tag.gated { background: var(--ual-prot-tint); color: var(--ual-prot-ink); }
.dg-fn .tag.no { background: var(--ual-fault-tint); color: var(--ual-fault-ink); }
.dg-panel { background: var(--ual-surface); border: 1px solid var(--ual-line); border-radius: 18px; padding: 18px 20px; }
.dg-panel h3 { margin: 0 0 10px; font-family: var(--ual-display); font-size: 18px; color: var(--ual-ink); }
.dg-tbl { width: 100%; border-collapse: collapse; font-size: 13.5px; }
.dg-tbl th { text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: var(--ual-muted); font-weight: 600; padding: 6px 8px; }
.dg-tbl td { padding: 8px; border-top: 1px solid #eeefea; vertical-align: top; }
.dg-tbl td.v { font-family: var(--ual-code); font-size: 13px; }
.dg-tbl tr.stale td.v { color: var(--ual-neutral-ink); }
.dg-feed { max-height: 280px; overflow-y: auto; background: var(--ual-soft); border: 1px solid var(--ual-line); border-radius: 12px; padding: 10px 12px; font-family: var(--ual-code); font-size: 12px; line-height: 1.6; white-space: pre-wrap; margin-top: 10px; }
.dg-empty { color: var(--ual-muted); font-size: 13.5px; padding: 18px 4px; }
.dg .ok { color: var(--ual-clean-ink); } .dg .warn { color: var(--ual-prot-ink); } .dg .bad { color: var(--ual-fault); }

/* ---- the vehicle page (B1): vehicle column + system tiles + faults ---- */
.dg-hub { display: flex; flex-wrap: wrap; gap: 20px; align-items: flex-start; }
.dg-hub-aside { flex: 1 1 320px; max-width: 360px; display: flex; flex-direction: column; gap: 16px; }
.dg-hub-main { flex: 999 1 560px; min-width: 0; display: flex; flex-direction: column; gap: 18px; }
.dg-seg { display: inline-flex; gap: 4px; padding: 4px; background: #eff0eb; border-radius: 12px; align-self: flex-start; flex-wrap: wrap; }
.ual .dg-seg button { min-height: 36px; padding: 0 16px; border: none; border-radius: 9px; background: transparent; color: var(--ual-neutral-ink); font-weight: 500; }
.ual .dg-seg button:hover:not(:disabled) { background: rgba(255,255,255,.6); border: none; }
.ual .dg-seg button.on { background: var(--ual-surface); color: var(--ual-ink); font-weight: 600; box-shadow: 0 1px 2px rgba(0,0,0,.08); }
.dg-tile-lock { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; font-weight: 600; color: var(--ual-prot-ink); }
.dg-faults { padding: 6px 0 8px; }
.dg-faults-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 10px; padding: 14px 20px 8px; }
.dg-fgroup { display: flex; align-items: center; gap: 10px; padding: 10px 20px; background: #fafaf7; border-top: 1px solid #eeefea; }
.dg-fline { display: grid; grid-template-columns: 110px minmax(0, 1fr) auto; gap: 16px; align-items: center; padding: 8px 20px; border-top: 1px solid #f1f2ee; font-size: 13.5px; }
.dg-fline .c { font-family: var(--ual-code); font-size: 13px; font-weight: 500; }
.dg-fline .s { font-size: 12px; color: var(--ual-muted); }
.dg-foot { display: flex; gap: 8px; align-items: center; padding: 12px 28px; border-top: 1px solid var(--ual-line); background: var(--ual-surface); flex-wrap: wrap; }
.dg-foot.stick { position: sticky; bottom: 0; z-index: 5; margin: 18px -28px -32px; }
.dg-scanlist { display: flex; flex-direction: column; gap: 8px; }
.dg-history { display: flex; flex-direction: column; gap: 10px; }

/* ---- live map ---- */
.lm { padding: 18px 20px; display: flex; flex-direction: column; gap: 16px; }
.lm-title { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.lm-dot { width: 10px; height: 10px; border-radius: 5px; background: #9ca3af; }
.lm-dot.on { background: var(--ual-blue); animation: lm-pulse 1.2s ease-in-out infinite; }
@keyframes lm-pulse { 0%, 100% { box-shadow: 0 0 0 0 rgba(29,78,216,.45); } 50% { box-shadow: 0 0 0 6px rgba(29,78,216,0); } }
.lm-head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; font-size: 13.5px; }
.lm-pct { margin-left: auto; font-family: var(--ual-display); font-weight: 700; font-size: 18px; }
.lm-sweep { display: flex; flex-direction: column; gap: 8px; }
.lm-grid { display: grid; grid-template-columns: repeat(32, minmax(0, 1fr)); gap: 2px; max-width: 760px; }
.lm-cell { display: block; aspect-ratio: 1; border-radius: 2px; background: #ecede8; }
.lm-cell.asked { background: #c9ccc4; }
.lm-cell.now { background: var(--ual-blue); outline: 2px solid var(--ual-blue-line); }
.lm-cell.hit { background: var(--ual-blue); }
.lm-cell.skip { background: #f59e0b; }
.lm-cell.own { background: repeating-linear-gradient(45deg, #e3e4df, #e3e4df 2px, #f4f4f0 2px, #f4f4f0 4px); }
.lm-legend { display: flex; flex-wrap: wrap; gap: 14px; font-size: 12px; color: var(--ual-neutral-ink); }
.lm-legend span { display: inline-flex; align-items: center; gap: 6px; }
.lm-legend .lm-cell { width: 12px; height: 12px; }
.lm-hits { display: flex; flex-direction: column; gap: 8px; font-size: 13.5px; }
.lm-hit-row { display: flex; flex-wrap: wrap; gap: 6px; }
.lm-hit { padding: 4px 10px; border-radius: 999px; background: var(--ual-blue-tint); color: var(--ual-blue-ink); font-size: 12.5px; animation: lm-pop .35s ease-out; }
@keyframes lm-pop { from { transform: scale(.7); opacity: 0; } to { transform: scale(1); opacity: 1; } }
.lm-ident { display: flex; flex-direction: column; gap: 10px; }
.lm-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 10px; }
.lm-card { display: flex; flex-direction: column; gap: 4px; padding: 12px 14px; border-radius: 14px; background: var(--ual-soft); border: 1px solid var(--ual-line); font-size: 12.5px; min-height: 92px; transition: background .2s, border-color .2s; }
.lm-card.reading { background: var(--ual-surface); border: 2px solid var(--ual-blue); }
.lm-card.done { background: var(--ual-surface); }
.lm-card.quiet { opacity: .6; }
.lm-card.bad { border-color: var(--ual-fault-line); }
.lm-card-top { display: flex; align-items: center; gap: 8px; }
.lm-card-top b { font-family: var(--ual-display); font-size: 16px; }
.lm-card-name { color: var(--ual-muted); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lm-prot { font-size: 11.5px; font-weight: 600; color: var(--ual-prot-ink); }
.lm-rec { display: flex; gap: 8px; align-items: baseline; animation: lm-pop .3s ease-out; }
.lm-rec span { color: var(--ual-muted); min-width: 56px; }
.lm-rec b { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lm-rec.bad b { color: var(--ual-fault); }
.lm-spin { margin-left: auto; width: 14px; height: 14px; border-radius: 7px; border: 2px solid var(--ual-blue-line); border-top-color: var(--ual-blue); animation: lm-rot .8s linear infinite; }
@keyframes lm-rot { to { transform: rotate(360deg); } }

/* ---- module inventory ---- */
.inv-tbl { width: 100%; min-width: 860px; border-collapse: collapse; font-size: 13px; }
.inv-tbl th { text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: var(--ual-muted); font-weight: 600; padding: 12px 8px; white-space: nowrap; }
.inv-tbl td { padding: 10px 8px; border-top: 1px solid #eeefea; vertical-align: top; }
.inv-tbl td.ual-mono { font-size: 12.5px; }
.inv-tbl td.inv-v { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 150px; }
.inv-tbl td:first-child { min-width: 170px; max-width: 230px; }
.inv-tbl tbody tr { cursor: pointer; }
.inv-tbl tbody tr:hover td { background: #fafaf7; }
.inv-tbl tr.open td { background: #fafaf7; }
.inv-tbl tr.quiet td { color: var(--ual-muted); }
.inv-tbl tr.inv-detail { cursor: default; }
.inv-tbl tr.inv-detail td { background: var(--ual-soft); padding: 12px 18px; }
.inv-rec { display: grid; grid-template-columns: 110px 220px minmax(0, 1fr); gap: 12px; padding: 3px 0; font-size: 12.5px; }
.inv-rec b { font-weight: 500; word-break: break-all; }
`;
