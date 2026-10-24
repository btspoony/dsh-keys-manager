/** Stylesheet owned by the Keys Manager client surface. */
export const CSS = `
.km-page{max-width:920px;margin:0 auto;padding:0 0 8px;color:var(--dsw-alias-label-primary);font-size:13.5px;line-height:1.5}
.km-embedded-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin:0 0 16px}
.km-summary{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin:0 0 16px;flex:1;min-width:0}
.km-embedded-head .km-summary{margin:0}
.km-embedded-actions{display:flex;gap:8px;flex-shrink:0;padding-top:2px}
.km-summary-line{color:var(--dsw-alias-label-secondary);font-size:12.5px;line-height:1.5}
.km-stat{display:flex;flex-direction:column;gap:2px;padding:11px 14px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}
.km-stat strong{font-size:19px;line-height:1.15;font-weight:650;font-variant-numeric:tabular-nums}
.km-stat span{color:var(--dsw-alias-label-secondary);font-size:12px}
.km-filters{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 12px}
.km-chip{display:inline-flex;align-items:center;gap:6px;padding:5px 11px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font:inherit;font-size:12.5px;cursor:pointer}
.km-chip:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.km-chip:focus-visible{border-color:var(--dsw-alias-state-business-primary);box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-state-business-primary) 20%,transparent)}
.km-chip-on{border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 55%,var(--dsw-alias-border-l1));background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 12%,var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-label-primary)}
.km-chip-count{font-size:11.5px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.km-chip-on .km-chip-count{color:inherit}
.km-search{position:relative;display:flex;align-items:center;margin:0 0 20px}
.km-search-icon{position:absolute;left:12px;color:var(--dsw-alias-label-secondary);pointer-events:none}
.km-search-input{width:100%;box-sizing:border-box;padding:10px 38px 10px 36px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;outline:none}
.km-search-input:focus{border-color:var(--dsw-alias-state-business-primary);box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-state-business-primary) 20%,transparent)}
.km-search-clear{position:absolute;right:8px;display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
.km-search-clear:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.km-section{margin:0 0 22px}
.km-section-head{display:flex;align-items:baseline;gap:8px;margin:0 0 9px}
.km-section-title{font-size:14px;font-weight:650;margin:0;letter-spacing:.01em}
.km-section-count{font-size:12px;color:var(--dsw-alias-label-secondary)}
.km-provider-list{display:flex;flex-direction:column;gap:8px}
.km-show-more{display:flex;justify-content:center;padding:8px 0 0}
.km-card{border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);overflow:hidden}
.km-provider-managed{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 26%,var(--dsw-alias-border-l1))}
.km-provider-open{overflow:visible}
.km-provider-head{display:flex;align-items:center;gap:12px;width:100%;padding:12px 14px;border:0;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.km-provider-head:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary) 3%,transparent)}
.km-avatar{display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;flex:0 0 32px;border-radius:9px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);font-weight:650;font-size:13px;color:var(--dsw-alias-label-secondary)}
.km-provider-main{display:flex;flex-direction:column;gap:3px;min-width:0;flex:1}
.km-provider-title-line{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0}
.km-provider-name{font-weight:650;font-size:13.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:360px}
.km-provider-meta{display:flex;align-items:center;gap:7px;flex-wrap:wrap;color:var(--dsw-alias-label-secondary);font-size:11.5px;min-width:0}
.km-provider-side{display:flex;align-items:center;gap:9px;flex-shrink:0}
.km-count{font-size:11.5px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.km-chevron{color:var(--dsw-alias-label-secondary);transition:transform .16s ease}
.km-chevron-open{transform:rotate(180deg)}
.km-provider-body{border-top:1px solid var(--dsw-alias-border-l1);padding:13px 14px 14px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 40%,transparent)}
.km-adopt{display:flex;flex-direction:column;gap:12px}
.km-adopt-copy{display:flex;flex-direction:column;gap:5px;color:var(--dsw-alias-label-secondary);font-size:12.5px}
.km-adopt-title{color:var(--dsw-alias-label-primary);font-size:12.5px}
.km-adopt-actions{display:flex;gap:8px;align-items:center}
.km-meta-line{display:flex;gap:6px;align-items:baseline;flex-wrap:wrap;font-size:11.5px}
.km-managed-body{display:flex;flex-direction:column;gap:10px}
.km-managed-toolbar{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap}
.km-managed-summary{display:flex;flex-direction:column;gap:2px;min-width:0;font-size:11.5px}
.km-managed-actions{display:flex;gap:6px;align-items:center;flex-shrink:0}
.km-keys{display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l1);border-radius:9px;background:var(--dsw-alias-bg-layer-1);overflow:visible}
.km-key-row{position:relative;display:grid;grid-template-columns:minmax(0,1.35fr) minmax(150px,.8fr) minmax(150px,.9fr) 32px;gap:10px;align-items:center;padding:10px 11px;border-top:1px solid var(--dsw-alias-border-l1)}
.km-key-row:first-child{border-top:0}
.km-account-row{position:relative;display:grid;grid-template-columns:minmax(0,1.35fr) minmax(150px,.8fr) minmax(150px,.9fr) 32px;gap:10px;align-items:center;padding:10px 11px 10px 14px;border-top:1px solid var(--dsw-alias-border-l1)}
.km-account-row:first-child{border-top:0}
.km-account-row::before{content:'';position:absolute;left:0;top:12px;bottom:12px;width:2px;border-radius:1px;background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 55%,transparent)}
.km-transport-row{grid-template-columns:minmax(0,1.35fr) minmax(150px,.8fr) minmax(150px,.9fr) auto}
.km-transport-body{display:flex;flex-direction:column;gap:10px}
.km-models{border:1px solid var(--dsw-alias-border-l1);border-radius:9px;background:var(--dsw-alias-bg-layer-1)}
.km-models-head{display:flex;align-items:center;gap:7px;width:100%;padding:9px 11px;border:0;border-radius:9px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;font-weight:550;text-align:left;cursor:pointer}
.km-models-head:hover{background:var(--dsw-alias-bg-layer-2)}
.km-models-title{font-weight:600}
.km-models-body{display:flex;flex-direction:column;gap:9px;padding:9px 11px 11px;border-top:1px solid var(--dsw-alias-border-l1)}
.km-models-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:3px 10px;max-height:220px;overflow:auto}
.km-model-option{display:flex;align-items:center;gap:7px;min-width:0;font-size:12px;color:var(--dsw-alias-label-primary);cursor:pointer}
.km-model-option input{flex:0 0 auto;margin:0;accent-color:var(--dsw-alias-state-business-primary)}
.km-model-option span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.km-models-actions{display:flex;justify-content:flex-end;gap:8px}
.km-models-failure{display:flex;flex-direction:column;gap:8px;align-items:flex-start}
.km-account-glyph{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;flex:0 0 22px;border-radius:50%;background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 14%,var(--dsw-alias-bg-layer-2));color:var(--dsw-alias-state-business-primary)}
.km-key-identity{min-width:0;display:flex;flex-direction:column;gap:2px}
.km-key-alias-line{display:flex;align-items:center;gap:6px;min-width:0}
.km-key-alias{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:220px}
.km-key-sub{display:flex;align-items:center;gap:8px;font-size:11px;color:var(--dsw-alias-label-secondary);flex-wrap:wrap}
.km-key-status{display:flex;flex-direction:column;gap:2px;align-items:flex-start}
.km-key-last{display:flex;flex-direction:column;gap:2px;min-width:0}
.km-key-time{font-size:11.5px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.km-key-time.km-warn{color:var(--dsw-alias-state-warn-primary)}
.km-key-actions{position:relative;display:flex;justify-content:flex-end;gap:6px}
.km-status{display:inline-flex;align-items:center;gap:5px;padding:2px 7px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);font-size:11px;white-space:nowrap;color:var(--dsw-alias-label-secondary)}
.km-status-success{color:var(--dsw-alias-state-success-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 26%,var(--dsw-alias-border-l1));background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 8%,transparent)}
.km-status-warn{color:var(--dsw-alias-state-warn-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 30%,var(--dsw-alias-border-l1));background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 8%,transparent)}
.km-status-error{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 30%,var(--dsw-alias-border-l1));background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,transparent)}
.km-status-idle{color:var(--dsw-alias-state-idle-primary)}
.km-dot{display:inline-block;width:6px;height:6px;border-radius:50%;flex:0 0 6px;background:var(--dsw-alias-state-idle-primary)}
.km-dot-success{background:var(--dsw-alias-state-success-primary)}
.km-dot-warn{background:var(--dsw-alias-state-warn-primary)}
.km-dot-error{background:var(--dsw-alias-state-error-primary)}
.km-dot-idle{background:var(--dsw-alias-state-idle-primary)}
.km-dot-sep{color:var(--dsw-alias-label-secondary)}
.km-tag{display:inline-flex;align-items:center;padding:1px 6px;border-radius:5px;font-size:10.5px;line-height:1.45;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);white-space:nowrap}
.km-tag-accent{color:var(--dsw-alias-state-business-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 34%,var(--dsw-alias-border-l1));background:var(--dsw-alias-state-business-tertiary)}
.km-tag-warn{color:var(--dsw-alias-state-warn-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 30%,var(--dsw-alias-border-l1));background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 8%,transparent)}
.km-icon-btn{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border:1px solid transparent;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;flex:0 0 auto}
.km-icon-btn:hover{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l1);color:var(--dsw-alias-label-primary)}
.km-icon-btn:disabled{opacity:.5;cursor:default}
.km-menu{position:absolute;top:32px;right:0;z-index:20;min-width:138px;padding:4px;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;background:var(--dsw-alias-bg-overlay);box-shadow:0 7px 22px color-mix(in srgb,var(--dsw-alias-label-primary) 14%,transparent)}
.km-menu-item{display:flex;align-items:center;gap:8px;width:100%;padding:7px 9px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;text-align:left;cursor:pointer}
.km-menu-item:hover{background:var(--dsw-alias-bg-layer-2)}
.km-menu-item:disabled{opacity:.5;cursor:default}
.km-menu-danger{color:var(--dsw-alias-state-error-primary)}
.km-menu-sep{height:1px;margin:4px 2px;background:var(--dsw-alias-border-l1)}
.km-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:7px 11px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;font-weight:550;line-height:1.2;cursor:pointer;white-space:nowrap;transition:opacity .15s ease,background .15s ease}
.km-btn:hover{background:var(--dsw-alias-bg-layer-2)}
.km-btn:disabled{opacity:.5;cursor:default}
.km-btn-primary{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-base);border-color:transparent}
.km-btn-primary:hover{opacity:.9;background:var(--dsw-alias-label-primary)}
.km-btn-ghost{background:transparent;border-color:transparent;color:var(--dsw-alias-label-secondary)}
.km-btn-ghost:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.km-btn-danger{background:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-bg-base);border-color:transparent}
.km-btn-danger:hover{opacity:.9;background:var(--dsw-alias-state-error-primary)}
.km-btn-small{padding:5px 8px;font-size:12px;border-radius:7px}
.km-input{width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;outline:none}
.km-input:focus{border-color:var(--dsw-alias-state-business-primary);box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-state-business-primary) 18%,transparent)}
.km-input:disabled{opacity:.6}
select.km-input{appearance:auto}
.km-form{display:flex;flex-direction:column;gap:10px;padding:12px;border:1px solid var(--dsw-alias-border-l1);border-radius:9px;background:var(--dsw-alias-bg-layer-1)}
.km-form-lead{display:flex;flex-direction:column;gap:2px}
.km-form-title{font-weight:650;font-size:12.5px}
.km-form-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.4fr);gap:10px}
.km-field{display:flex;flex-direction:column;gap:5px;min-width:0}
.km-field-wide{min-width:0}
.km-field-label{font-size:11.5px;font-weight:550;color:var(--dsw-alias-label-secondary)}
.km-field-hint{font-size:11px;color:var(--dsw-alias-label-secondary);line-height:1.45}
.km-secret{position:relative;display:flex;align-items:center}
.km-secret-input{padding-right:38px}
.km-secret-toggle{position:absolute;right:4px;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
.km-secret-toggle:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.km-form-actions{display:flex;justify-content:flex-end;gap:8px}
.km-rename{display:flex;align-items:center;gap:4px;min-width:0;flex:1 1 auto;max-width:100%}
.km-rename-input{flex:1 1 auto;width:auto;min-width:60px;padding:4px 7px;font-size:12.5px}
.km-inline-error{padding:7px 9px;border:1px solid color-mix(in srgb,var(--dsw-alias-state-error-primary) 35%,var(--dsw-alias-border-l1));border-radius:7px;background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,transparent);color:var(--dsw-alias-state-error-primary);font-size:12px;word-break:break-word}
.km-key-error{grid-column:1/-1;margin-top:-2px}
.km-notice{display:flex;align-items:flex-start;gap:8px;padding:9px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:12px}
.km-notice-icon{flex:0 0 auto;margin-top:1px}
.km-notice-warn{border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 32%,var(--dsw-alias-border-l1));background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 7%,transparent)}
.km-notice-error{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 32%,var(--dsw-alias-border-l1));background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 7%,transparent)}
.km-notice-body{display:flex;flex-direction:column;gap:2px;min-width:0}
.km-notice-title{color:var(--dsw-alias-label-primary);font-weight:600;font-size:12px}
.km-notice-text{line-height:1.5}
.km-notice-action{flex:0 0 auto}
.km-empty-keys{padding:12px;border:1px dashed var(--dsw-alias-border-l2);border-radius:8px;color:var(--dsw-alias-label-secondary);font-size:12px}
.km-empty{display:flex;align-items:center;gap:8px;padding:14px;border:1px dashed var(--dsw-alias-border-l2);border-radius:10px;color:var(--dsw-alias-label-secondary);font-size:12.5px}
.km-quota-compact{align-self:center;flex-shrink:0;padding:1px 6px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:11px;font-variant-numeric:tabular-nums;white-space:nowrap}
.km-quota-compact.km-quota-warn{color:var(--dsw-alias-state-warn-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 34%,var(--dsw-alias-border-l1))}
.km-quota-compact.km-quota-error{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 34%,var(--dsw-alias-border-l1))}
.km-quota-strip{display:flex;flex-direction:column;gap:2px;margin:8px 0 9px;padding:6px 9px 5px;border:1px solid var(--dsw-alias-border-l1);border-radius:9px;background:var(--dsw-alias-bg-layer-1)}
.km-quota-head{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:10.5px;letter-spacing:.04em;text-transform:uppercase;color:var(--dsw-alias-label-secondary)}
.km-quota-busy{color:var(--dsw-alias-brand-primary);letter-spacing:0;text-transform:none}
.km-quota-list{display:flex;flex-direction:column;margin:0;padding:0;list-style:none}
.km-quota-row{display:flex;align-items:center;gap:8px;min-height:22px;max-height:26px;padding:0;font-size:11px;line-height:1.3}
.km-quota-alias{flex:0 1 30%;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary)}
.km-quota-metrics{display:flex;flex:1;align-items:center;justify-content:flex-end;gap:7px;min-width:0}
.km-quota-stale .km-quota-track,.km-quota-stale .km-quota-pct,.km-quota-stale .km-quota-reset{opacity:.55}
.km-quota-metric{display:inline-flex;align-items:center;gap:4px;flex-shrink:0}
.km-quota-window{min-width:15px;font-size:10.5px;color:var(--dsw-alias-label-secondary)}
.km-quota-track{position:relative;display:inline-block;width:42px;height:5px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);box-shadow:inset 0 0 0 1px var(--dsw-alias-border-l1);overflow:hidden}
.km-quota-fill{display:block;height:100%;border-radius:999px;background:var(--dsw-alias-brand-primary)}
.km-quota-fill-warn{background:var(--dsw-alias-state-warn-primary)}
.km-quota-fill-error{background:var(--dsw-alias-state-error-primary)}
.km-quota-pct{min-width:28px;text-align:right;font-size:11px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary)}
.km-quota-reset{font-size:10.5px;font-variant-numeric:tabular-nums;white-space:nowrap;color:var(--dsw-alias-label-secondary)}
.km-quota-flag{padding:0 4px;border-radius:4px;font-size:10px;color:var(--dsw-alias-state-warn-primary);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 12%,transparent)}
.km-quota-note{margin-left:auto;font-size:10.5px;color:var(--dsw-alias-label-secondary)}
.km-provider-foot{display:flex;justify-content:space-between;gap:10px;align-items:center;margin-top:10px;padding-top:9px;border-top:1px dashed var(--dsw-alias-border-l1);font-size:11px;min-height:15px}
.km-settings{padding:14px}
.km-settings-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:12px}
.km-settings-title{font-size:14px;font-weight:650;margin:0 0 3px}
.km-settings-intro{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px}
.km-settings-icon{display:inline-flex;align-items:center;justify-content:center;width:34px;height:34px;border-radius:9px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-brand-primary);border:1px solid var(--dsw-alias-border-l1)}
.km-settings-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr) minmax(0,1fr);gap:12px;align-items:start}
.km-field-note{grid-column:1/-1}
.km-policy-note{padding:9px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2)}
.km-policy-title{display:flex;align-items:center;gap:6px;font-size:11.5px;font-weight:600;color:var(--dsw-alias-label-primary);margin-bottom:2px}
.km-policy-note p{margin:0;font-size:11.5px;line-height:1.5}
.km-settings-actions{display:flex;align-items:center;justify-content:flex-end;gap:10px;margin-top:12px}
.km-saved{display:inline-flex;align-items:center;gap:4px;color:var(--dsw-alias-state-success-primary);font-size:11.5px}
.km-banner{display:flex;align-items:flex-start;gap:8px;padding:9px 10px;border-radius:8px;margin:0 0 12px;font-size:12px;line-height:1.5;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}
.km-banner-error{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 32%,var(--dsw-alias-border-l1));background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 7%,transparent)}
.km-banner-warn{border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 32%,var(--dsw-alias-border-l1));background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 7%,transparent)}
.km-banner-text{flex:1;min-width:0;word-break:break-word}
.km-banner-close{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border:0;border-radius:5px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
.km-banner-close:hover{background:var(--dsw-alias-bg-layer-2)}
.km-loading{display:flex;align-items:center;gap:8px;padding:20px 0;color:var(--dsw-alias-label-secondary);font-size:12.5px}
.km-load-failure{display:flex;flex-direction:column;gap:10px;align-items:flex-start;padding:18px;border:1px dashed var(--dsw-alias-border-l2);border-radius:10px;color:var(--dsw-alias-label-secondary);font-size:12.5px}
.km-empty-title{font-weight:600;color:var(--dsw-alias-label-primary)}
.km-footer{display:flex;align-items:flex-start;gap:6px;padding-top:4px;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1.5}
.km-muted{color:var(--dsw-alias-label-secondary)}
.km-warn{color:var(--dsw-alias-state-warn-primary)}
.km-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px}
.km-truncate{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.km-spin{animation:km-spin 1s linear infinite}
.km-models-note{display:flex;align-items:center;gap:7px;flex-wrap:wrap;margin:8px 0 0;padding:7px 9px;border:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 24%,var(--dsw-alias-border-l1));border-radius:7px;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 6%,transparent);font-size:11.5px;color:var(--dsw-alias-label-primary)}
.km-models-note-warn{border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 30%,var(--dsw-alias-border-l1));background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 7%,transparent)}
.km-models-note-text{font-weight:600}
.km-models-note-hint{color:var(--dsw-alias-label-secondary);font-weight:400}
.km-modal-backdrop{position:fixed;inset:0;z-index:80;display:flex;align-items:center;justify-content:center;padding:24px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 26%,transparent)}
.km-modal{width:min(440px,100%);border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-overlay);padding:16px;box-shadow:0 18px 48px color-mix(in srgb,var(--dsw-alias-label-primary) 20%,transparent)}
.km-modal-title{font-weight:650;font-size:14px;margin-bottom:7px}
.km-modal-body{color:var(--dsw-alias-label-secondary);font-size:12.5px}
.km-modal-copy{margin:0;line-height:1.55}
.km-login-flow{display:flex;flex-direction:column;gap:10px}
.km-login-pending{display:flex;align-items:center;gap:8px;color:var(--dsw-alias-label-secondary);font-size:12.5px}
.km-login-notices{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.5;word-break:break-word}
.km-login-link{color:var(--dsw-alias-state-business-primary);text-decoration:underline;text-underline-offset:2px}
.km-login-link:hover{color:var(--dsw-alias-label-primary)}
.km-login-prompt{display:flex;flex-direction:column;gap:10px;padding-top:2px;border-top:1px dashed var(--dsw-alias-border-l1)}
.km-login-prompt-title{font-weight:600;font-size:12.5px;color:var(--dsw-alias-label-primary)}
.km-modal-footer{display:flex;justify-content:flex-end;gap:8px;margin-top:16px}
@keyframes km-spin{to{transform:rotate(360deg)}}
@media(max-width:720px){
  .km-summary{grid-template-columns:repeat(2,minmax(0,1fr))}
  .km-key-row,.km-account-row{grid-template-columns:minmax(0,1fr) 32px;gap:6px}
  .km-key-status,.km-key-last{grid-column:1;padding-left:0}
  .km-key-actions{grid-column:2;grid-row:1}
  .km-transport-row{grid-template-columns:minmax(0,1fr) auto}
  .km-transport-row .km-key-actions{justify-content:flex-end;flex-wrap:wrap}
  .km-settings-grid{grid-template-columns:1fr}
  .km-form-grid{grid-template-columns:1fr}
  .km-provider-side .km-status{display:none}
  /* Narrow cards drop the supplementary one-liner and the countdown rather
     than wrapping; the expanded strip stays the primary carrier. */
  .km-provider-side .km-quota-compact{display:none}
  .km-quota-reset{display:none}
  .km-embedded-head{flex-direction:column;gap:10px}
  .km-embedded-actions{padding-top:0}
}
`
