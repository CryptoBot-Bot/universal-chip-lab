/** Styles for the scan-tool flow (Diagnostics). One sheet, mounted once by DiagnosticsTab. */
export const diagStyles = `
.dg { display: flex; flex-direction: column; height: 100%; min-height: 0; background: var(--bg-0); }

/* path bar — where you are, how to get back, what the tool is connected to */
.dg-bar { display: flex; align-items: center; gap: 8px; padding: 8px 16px; background: var(--bg-1); border-bottom: 1px solid var(--border); min-height: 52px; }
.dg-bar .dg-nav { padding: 6px 12px; font-size: 15px; line-height: 1; }
.dg-path { display: flex; align-items: center; gap: 6px; font-size: 13px; color: var(--fg-1); flex-wrap: wrap; }
.dg-path b { color: var(--fg-0); font-weight: 600; }
.dg-path .sep { color: var(--fg-2); }
.dg-path button { background: none; border: none; padding: 2px 4px; color: var(--fg-1); font-size: 13px; }
.dg-path button:hover:not(:disabled) { background: none; color: var(--fg-0); text-decoration: underline; }
.dg-spacer { flex: 1; }
.dg-vci { display: flex; align-items: center; gap: 8px; padding: 6px 12px; border-radius: 999px; border: 1px solid var(--border-strong); background: var(--bg-2); font-size: 12px; position: relative; }
.dg-vci .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--fg-2); }
.dg-vci.on .dot { background: var(--accent); box-shadow: 0 0 8px var(--accent); }
.dg-vci.err .dot { background: var(--danger); }
.dg-vci.busy .dot { background: var(--warn); }
.dg-chip { font-size: 11px; font-weight: 700; letter-spacing: .05em; padding: 3px 9px; border-radius: 999px; border: 1px solid var(--warn); color: var(--warn); background: var(--warn-dim); }
.dg-chip.demo { border-color: var(--info); color: var(--info); background: var(--info-dim); }
.dg-pop { position: absolute; right: 0; top: calc(100% + 8px); z-index: 30; width: 380px; background: var(--bg-1); border: 1px solid var(--border-strong); border-radius: 10px; padding: 12px; box-shadow: 0 16px 40px rgba(0,0,0,.55); }
.dg-pop h4 { margin: 0 0 8px; font-size: 12px; text-transform: uppercase; letter-spacing: .08em; color: var(--fg-1); }
.dg-dev { display: flex; align-items: center; gap: 8px; width: 100%; text-align: left; padding: 8px 10px; margin-bottom: 6px; background: var(--bg-2); border: 1px solid var(--border); border-radius: 8px; }
.dg-dev.sel { border-color: var(--accent); }
.dg-dev small { display: block; color: var(--fg-2); font-size: 11px; }
.dg-in { background: var(--bg-2); border: 1px solid var(--border-strong); border-radius: 6px; color: var(--fg-0); padding: 8px 10px; font-size: 13px; font-family: var(--mono); }

.dg-body { flex: 1; min-height: 0; overflow-y: auto; padding: 18px 22px 24px; }
.dg-h { font-size: 20px; font-weight: 650; margin: 0 0 4px; }
.dg-sub { color: var(--fg-1); font-size: 13px; margin: 0 0 16px; }
.dg-note { margin: 0 0 14px; padding: 9px 12px; border-radius: 8px; border: 1px solid var(--border-strong); background: var(--bg-2); font-size: 13px; }
.dg-note.warn { border-color: var(--warn); background: var(--warn-dim); }
.dg-note.err { border-color: var(--danger); background: var(--danger-dim); }
.dg-note.ok { border-color: var(--accent); background: var(--accent-dim); }

/* big entry tiles */
.dg-tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 14px; margin-bottom: 22px; }
.dg-tile { display: flex; flex-direction: column; align-items: flex-start; gap: 6px; text-align: left; min-height: 128px; padding: 16px 18px; border-radius: 12px; background: linear-gradient(160deg, var(--bg-3), var(--bg-2)); border: 1px solid var(--border-strong); }
.dg-tile:hover:not(:disabled) { border-color: var(--accent); background: linear-gradient(160deg, #1d2a37, var(--bg-2)); }
.dg-tile .ico { font-size: 26px; line-height: 1; }
.dg-tile .t { font-size: 16px; font-weight: 650; letter-spacing: .02em; }
.dg-tile .d { font-size: 12px; color: var(--fg-1); line-height: 1.4; }
.dg-tile.hot { border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent-dim); }
.dg-tile.hot .t { color: var(--accent); }
.dg-tile .cnt { margin-top: auto; font-size: 11px; color: var(--accent); font-weight: 600; }

/* make / model pickers */
.dg-brands { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; }
.dg-brand { min-height: 74px; display: flex; flex-direction: column; justify-content: center; align-items: center; gap: 4px; border-radius: 10px; background: var(--bg-2); border: 1px solid var(--border); font-size: 15px; font-weight: 600; }
.dg-brand small { font-size: 10.5px; font-weight: 500; color: var(--fg-2); }
.dg-brand.has { border-color: var(--border-strong); background: var(--bg-3); }
.dg-brand.has small { color: var(--accent); }
.dg-list { display: flex; flex-direction: column; gap: 8px; }
.dg-item { display: flex; align-items: center; gap: 14px; text-align: left; padding: 12px 16px; border-radius: 10px; background: var(--bg-2); border: 1px solid var(--border); width: 100%; }
.dg-item:hover:not(:disabled) { border-color: var(--accent); }
.dg-item .main { flex: 1; min-width: 0; }
.dg-item .main b { display: block; font-size: 15px; }
.dg-item .main small { color: var(--fg-1); font-size: 12px; }
.dg-item .chev { color: var(--fg-2); font-size: 18px; }
.dg-form { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-top: 12px; }

/* vehicle header */
.dg-veh { display: flex; gap: 18px; align-items: center; padding: 14px 18px; border-radius: 12px; background: var(--bg-1); border: 1px solid var(--border-strong); margin-bottom: 14px; flex-wrap: wrap; }
.dg-veh .name { font-size: 21px; font-weight: 700; letter-spacing: .01em; }
.dg-veh .meta { color: var(--fg-1); font-size: 12.5px; margin-top: 2px; }
.dg-veh .kv { display: flex; flex-direction: column; font-size: 11px; color: var(--fg-2); text-transform: uppercase; letter-spacing: .06em; }
.dg-veh .kv b { font-size: 15px; color: var(--fg-0); text-transform: none; letter-spacing: 0; font-family: var(--mono); font-weight: 600; }
.dg-tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--border); margin-bottom: 14px; }
.dg-tabs button { background: none; border: none; border-bottom: 3px solid transparent; border-radius: 0; padding: 10px 16px; font-size: 14px; color: var(--fg-1); font-weight: 600; }
.dg-tabs button.on { color: var(--fg-0); border-bottom-color: var(--accent); }
.dg-tabs button:hover:not(:disabled) { background: var(--bg-2); }

/* the scan list */
.dg-scanhead { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; flex-wrap: wrap; }
.dg-prog { height: 6px; border-radius: 3px; background: var(--bg-3); overflow: hidden; margin-bottom: 10px; }
.dg-prog > i { display: block; height: 100%; background: var(--accent); transition: width .25s; }
.dg-sys { display: grid; grid-template-columns: 34px minmax(0, 1fr) 150px 170px 30px; gap: 10px; align-items: center; padding: 10px 14px; border-radius: 9px; background: var(--bg-2); border: 1px solid var(--border); margin-bottom: 6px; width: 100%; text-align: left; }
.dg-sys:hover:not(:disabled) { border-color: var(--border-strong); background: var(--bg-3); }
.dg-sys.quiet { opacity: .55; }
.dg-sys .n { color: var(--fg-2); font-family: var(--mono); font-size: 12px; }
.dg-sys .nm b { display: block; font-size: 14px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dg-sys .nm small { color: var(--fg-2); font-size: 11.5px; display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dg-sys .ad { font-family: var(--mono); font-size: 12px; color: var(--fg-1); }
.dg-st { justify-self: start; font-size: 12px; font-weight: 700; padding: 4px 11px; border-radius: 999px; border: 1px solid var(--border-strong); color: var(--fg-2); white-space: nowrap; }
.dg-st.ok { color: var(--accent); border-color: var(--accent); background: var(--accent-dim); }
.dg-st.fault { color: #fff; border-color: var(--danger); background: #b02a2a; }
.dg-st.none { color: var(--fg-2); }
.dg-st.unk { color: var(--warn); border-color: var(--warn); background: var(--warn-dim); }
.dg-st.run { color: var(--info); border-color: var(--info); background: var(--info-dim); }
.dg-dtcs { margin: -2px 0 8px 44px; border-left: 2px solid var(--danger); padding: 4px 0 4px 12px; }
.dg-dtc { display: grid; grid-template-columns: 96px minmax(0, 1fr) auto; gap: 10px; font-size: 12.5px; padding: 3px 0; }
.dg-dtc .c { font-family: var(--mono); font-weight: 700; color: var(--danger); }
.dg-dtc .s { color: var(--fg-2); font-size: 11.5px; }
.dg-foot { display: flex; gap: 8px; align-items: center; padding: 10px 16px; border-top: 1px solid var(--border); background: var(--bg-1); flex-wrap: wrap; }
.dg-foot button { min-width: 120px; padding: 10px 16px; font-size: 13.5px; font-weight: 600; }
.dg-foot.stick { position: sticky; bottom: -24px; margin: 0 -22px -24px; z-index: 5; }
.dg-cat { font-size: 11.5px; text-transform: uppercase; letter-spacing: .08em; color: var(--fg-2); margin: 14px 0 6px; }

/* function menu inside a system */
.dg-fns { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 12px; margin-bottom: 16px; }
.dg-fn { min-height: 104px; display: flex; flex-direction: column; align-items: flex-start; gap: 5px; text-align: left; padding: 13px 15px; border-radius: 11px; background: var(--bg-2); border: 1px solid var(--border-strong); }
.dg-fn:hover:not(:disabled) { border-color: var(--accent); }
.dg-fn.on { border-color: var(--accent); background: var(--accent-dim); }
.dg-fn .ico { font-size: 22px; line-height: 1; }
.dg-fn .t { font-size: 14.5px; font-weight: 650; }
.dg-fn .d { font-size: 11.5px; color: var(--fg-1); line-height: 1.35; }
.dg-fn .tag { margin-top: auto; font-size: 10.5px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; color: var(--fg-2); }
.dg-fn .tag.yes { color: var(--accent); } .dg-fn .tag.gated { color: var(--warn); } .dg-fn .tag.no { color: var(--danger); }
.dg-panel { background: var(--bg-1); border: 1px solid var(--border-strong); border-radius: 12px; padding: 14px 16px; }
.dg-panel h3 { margin: 0 0 10px; font-size: 14px; text-transform: none; letter-spacing: 0; color: var(--fg-0); }
.dg-tbl { width: 100%; border-collapse: collapse; font-size: 13px; }
.dg-tbl th { text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: var(--fg-2); font-weight: 600; padding: 4px 8px; }
.dg-tbl td { padding: 7px 8px; border-top: 1px solid var(--border); vertical-align: top; }
.dg-tbl td.v { font-family: var(--mono); }
.dg-tbl tr.stale td.v { color: var(--fg-1); }
.dg-feed { max-height: 260px; overflow-y: auto; background: var(--bg-0); border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; font-family: var(--mono); font-size: 11.5px; line-height: 1.55; white-space: pre-wrap; margin-top: 10px; }
.dg-empty { color: var(--fg-1); font-size: 13px; padding: 18px 4px; }
.dg .ok { color: var(--accent); } .dg .warn { color: var(--warn); } .dg .bad { color: var(--danger); }
`;
