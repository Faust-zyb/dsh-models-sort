;(() => {
	function makeFactory() {
		return (require) => {
			const react = require("react");
			const { jsx: h } = require("react/jsx-runtime");

			const name = "dsh-models-sort";
			const inject = ["slots"];
			const TAG = "[models-sort]";
			const STYLE_ID = "dsh-models-sort-style";
			const CARD_ATTR = "data-dsh-ms-card";
			const HANDLE_ATTR = "data-dsh-ms-handle";
			const ENDPOINT = "/dsh-models-sort/order";
			const BADGES = new Set(["自定义", "内置", "已登录", "已配置", "官方", "账号"]);
			const HIDE_ATTR = "data-dsh-ms-hide";
			const DIVIDER_CLASS = "dsh-ms-hidden-divider";
			const BUTTON_LABELS = new Set(["编辑", "删除", "隐藏", "显示"]);
			let hiddenNames = new Set();
			let hiddenReady = false;
			let dragging = false;

			function normName(s) {
				return String(s || "").toLowerCase().replace(/[\s·「」『』"'`]/g, "");
			}

			// ---------- 样式 ----------
			function ensureStyle() {
				if (document.getElementById(STYLE_ID)) return;
				const style = document.createElement("style");
				style.id = STYLE_ID;
				style.textContent = [
					".dsh-ms-handle{position:absolute;left:7px;top:50%;transform:translateY(-50%);display:inline-flex;align-items:center;justify-content:center;width:16px;height:26px;border-radius:5px;color:inherit;opacity:.35;cursor:grab;user-select:none;font-size:13px;line-height:1;letter-spacing:-1px;transition:opacity .15s ease,background .15s ease;touch-action:none;z-index:2}",
					".dsh-ms-handle:hover{opacity:.95;background:rgba(127,127,127,.16)}",
					".dsh-ms-handle:active{cursor:grabbing}",
					"[" + CARD_ATTR + "]{will-change:transform}",
					"[" + CARD_ATTR + "].dsh-ms-dragging{opacity:.94;box-shadow:0 12px 32px rgba(0,0,0,.22);z-index:3;cursor:grabbing}",
					".dsh-ms-spacer{flex:none;align-self:stretch;pointer-events:none}",
					".dsh-ms-hide-fallback{box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.35));border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,#888);cursor:pointer;font:inherit;font-size:12px;line-height:16px;padding:2px 8px;margin-right:4px}",
					"[" + CARD_ATTR + "].dsh-ms-hidden{opacity:.55}",
					"[" + CARD_ATTR + "].dsh-ms-hidden [" + HIDE_ATTR + "]{opacity:1}",
					"." + DIVIDER_CLASS + "{color:var(--dsw-alias-label-tertiary,#999);font-size:11px;line-height:16px;letter-spacing:.04em;margin:10px 0 2px;user-select:none}",
					"@media (prefers-reduced-motion:reduce){[" + CARD_ATTR + "],[" + CARD_ATTR + "].dsh-ms-dragging{transition:none!important}}", 
					"#dsh-ms-toast{position:fixed;left:50%;bottom:34px;transform:translateX(-50%) translateY(8px);padding:7px 15px;border-radius:999px;font-size:12px;background:rgba(20,20,22,.9);color:#fff;opacity:0;pointer-events:none;transition:opacity .18s ease,transform .18s ease;z-index:2147483000;max-width:70vw}",
					"#dsh-ms-toast.dsh-ms-show{opacity:1;transform:translateX(-50%) translateY(0)}",
					"#dsh-ms-toast.dsh-ms-error{background:rgba(170,40,40,.94)}"
				].join("\n");
				document.head.appendChild(style);
			}

			function toast(text, isError) {
				let el = document.getElementById("dsh-ms-toast");
				if (!el) {
					el = document.createElement("div");
					el.id = "dsh-ms-toast";
					document.body.appendChild(el);
				}
				el.textContent = text;
				el.classList.toggle("dsh-ms-error", isError === true);
				el.classList.add("dsh-ms-show");
				clearTimeout(toast._timer);
				toast._timer = setTimeout(() => el.classList.remove("dsh-ms-show"), 2400);
			}

			// ---------- 找卡片 ----------
			function buttonText(el) {
				return (el.textContent || "").trim();
			}

			function findAddButton() {
				for (const el of document.querySelectorAll("button,[role='button']")) {
					if (buttonText(el).includes("添加模型提供商")) return el;
				}
				return null;
			}

			/** 自定义供应商才有"删除"；内置的 DeepSeek 那行只有"编辑"，不给手柄 */
			function isCustomCard(el) {
				let hasRemove = false;
				let hasEdit = false;
				for (const b of el.querySelectorAll("button,[role='button']")) {
					const t = buttonText(b);
					if (t === "删除") hasRemove = true;
					else if (t === "编辑") hasEdit = true;
				}
				return hasRemove && hasEdit;
			}

			function cardsUnder(host) {
				const out = [];
				for (const el of host.children) {
					if (el.nodeType !== 1) continue;
					if (isCustomCard(el)) out.push(el);
				}
				return out;
			}

			/** 兜底：从"删除"按钮往上爬定位卡片，再按共同父节点分组 */
			function cardsByRemoveButtons() {
				const cards = [];
				for (const b of document.querySelectorAll("button,[role='button']")) {
					if (buttonText(b) !== "删除") continue;
					let node = b;
					let prev = null;
					while (node && node !== document.body) {
						const count = [...node.querySelectorAll("button,[role='button']")].filter((x) => buttonText(x) === "删除").length;
						if (node !== b && count > 1) break;
						prev = node;
						node = node.parentElement;
					}
					if (prev && cards.indexOf(prev) < 0 && isCustomCard(prev)) cards.push(prev);
				}
				const groups = new Map();
				for (const card of cards) {
					const p = card.parentElement;
					if (!p) continue;
					if (!groups.has(p)) groups.set(p, []);
					groups.get(p).push(card);
				}
				let best = [];
				for (const list of groups.values()) if (list.length > best.length) best = list;
				return best.sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
			}

			function collectCards() {
				const add = findAddButton();
				let cards = [];
				if (add && add.parentElement) cards = cardsUnder(add.parentElement);
				if (cards.length < 2) cards = cardsByRemoveButtons();
				return cards;
			}

			/** 标题 = 第一行非杂项文本。跳过手柄、按钮、徽标。 */
			function cardName(card) {
				const lines = (card.innerText || "").split("\n").map((s) => s.trim()).filter(Boolean);
				for (const raw of lines) {
					const line = raw.replace(/⠿/g, "").trim();
					if (!line) continue;
					if (line === "编辑" || line === "删除" || BADGES.has(line)) continue;
					// 按钮和标题同一行时，把按钮文字拆掉，只留标题
					const kept = line.split(/\s+/).filter((t) => t && !BUTTON_LABELS.has(t) && !BADGES.has(t)).join(" ").trim();
					if (!kept) continue;
					return kept.replace(/[\s·]*(自定义|内置|官方)$/, "").trim();
				}
				return "";
			}

			// ---------- 拖拽 ----------
			function isSortableCard(el) {
				return el && el.nodeType === 1 && typeof el.hasAttribute === "function" && el.hasAttribute(CARD_ATTR);
			}

			/**
			 * 跨越进度：S 曲线（smoothstep），起步和收尾都柔，中点正好让位过半。
			 * 用它代替线性比例，卡片交叉时不会一路硬冲。
			 */
			function crossProgress(reach, span) {
				const x = Math.min(Math.max(reach / span, 0), 1);
				return x * x * (3 - 2 * x);
			}

			function onPointerDown(event) {
				const handle = event.currentTarget;
				if (!handle || (event.button !== undefined && event.button !== 0)) return;
				const card = handle.closest("[" + CARD_ATTR + "]");
				if (!card || !card.parentElement) return;

				const parent = card.parentElement;
				event.preventDefault();
				event.stopPropagation();
				try {
					handle.setPointerCapture(event.pointerId);
				} catch {}

				const startX = event.clientX;
				const startY = event.clientY;
				const rect = card.getBoundingClientRect();
				const computed = getComputedStyle(card);

				// 原始位置快照：位移全部基于它计算，避免"移动后又影响判断"的回路
				const cards = [];
				for (const el of parent.children) {
					if (!isSortableCard(el)) continue;
					const r = el.getBoundingClientRect();
					cards.push({ el, top: r.top, bottom: r.bottom, h: r.height });
				}
				const h0 = cards.findIndex((c) => c.el === card);
				if (h0 < 0) return;

				const below = cards[h0 + 1];
				const above = cards[h0 - 1];
				const gap = below ? Math.max(0, below.top - rect.bottom) : above ? Math.max(0, rect.top - above.bottom) : 0;
				const slot = rect.height + gap;

				let started = false;
				let spacer = null;
				let prev = null;
				let originX = 0;
				let originY = 0;
				let lastDy = 0;

				const place = (left, top) => {
					card.style.left = left - originX + "px";
					card.style.top = top - originY + "px";
				};

				// 真正拖起来才动样式：单纯按下/点击不改变卡片尺寸
				const begin = () => {
					started = true;
					dragging = true;
					// 占位符只负责撑住列表高度，视觉让位全交给兄弟元素的位移
					spacer = document.createElement("div");
					spacer.className = "dsh-ms-spacer";
					spacer.style.cssText = "box-sizing:border-box;height:" + rect.height + "px;margin:" + computed.margin;
					parent.insertBefore(spacer, card);

					prev = {
						position: card.style.position,
						top: card.style.top,
						left: card.style.left,
						width: card.style.width,
						height: card.style.height,
						boxSizing: card.style.boxSizing,
						margin: card.style.margin,
						zIndex: card.style.zIndex,
						transform: card.style.transform,
						boxShadow: card.style.boxShadow,
						transition: card.style.transition
					};
					// 卡片脱出文档流贴住指针（fixed + 坐标系校准，兼容带 transform 的祖先）
					card.style.position = "fixed";
					card.style.boxSizing = "border-box";
					card.style.width = rect.width + "px";
					card.style.height = rect.height + "px";
					card.style.left = "0px";
					card.style.top = "0px";
					card.style.margin = "0";
					card.style.zIndex = "30";
					const origin = card.getBoundingClientRect();
					originX = origin.left;
					originY = origin.top;
					place(rect.left, rect.top);

					card.classList.add("dsh-ms-dragging");
					card.style.transform = "scale(1.015) rotate(.12deg)";
					card.style.boxShadow = "0 14px 34px rgba(0,0,0,.22)";

					// 兄弟卡片加一小段过渡：让位是"顺着滑开"，不是跟着指针硬顶，
					// 既滤掉指针事件的抖动，也把两张卡片交叉时的相对冲撞柔化
					for (const c of cards) {
						if (c.el === card) continue;
						c.el.style.transition = "transform .16s cubic-bezier(.25,.8,.3,1)";
					}
				};

				const onMove = (ev) => {
					const dx = ev.clientX - startX;
					const dy = ev.clientY - startY;
					lastDy = dy;
					if (!started) {
						if (Math.abs(dx) < 3 && Math.abs(dy) < 3) return;
						begin();
					}
					place(rect.left + dx, rect.top + dy);

					// 连续让位：以"格"为单位算，换位点正好是半格，
					// 和落点判定（四舍五入到最近的格）严格一致 —— 不一致就会出现拖过了却被拽回上一格
					const f = dy / slot; // 拖了几格（正=向下）
					const dir = f > 0 ? 1 : f < 0 ? -1 : 0;
					for (const c of cards) {
						if (c.el === card) continue;
						const d = (c.top - rect.top) / slot; // 该卡片与起点隔几格
						let delta = 0;
						if (dir !== 0 && d !== 0 && (d > 0) === (dir > 0)) {
							// 刚靠近时轻推，半格处让位过半（= 换位点），压满一格正好让满
							const v = crossProgress(Math.abs(f) - Math.abs(d) + 1, 1);
							delta = -dir * v * slot;
						}
						c.el.style.transform = delta ? `translateY(${delta}px)` : "";
					}
				};

				const restore = () => {
					card.style.position = prev.position || "relative";
					card.style.top = prev.top;
					card.style.left = prev.left;
					card.style.width = prev.width;
					card.style.height = prev.height;
					card.style.boxSizing = prev.boxSizing;
					card.style.margin = prev.margin;
					card.style.zIndex = prev.zIndex;
					card.style.transform = prev.transform;
					card.style.boxShadow = prev.boxShadow;
					card.style.transition = prev.transition;
					card.classList.remove("dsh-ms-dragging");
				};

				const finish = () => {
					document.removeEventListener("pointermove", onMove, true);
					document.removeEventListener("pointerup", finish, true);
					document.removeEventListener("pointercancel", finish, true);
					dragging = false;

					if (!started) return;

					// 兜底：落位流程任何一步出错，都必须把卡片送回文档流，绝不停在松手处
					try {
						// 落点：四舍五入到最近的格 —— 与让位曲线的半格换位点严格一致，
						// 否则会出现在两格中间松手被拽回上一格（归位时向上的猛弹）
						// 用压缩坐标（列表里去掉被拖卡片本身）算，否则往下永远差一格
						const compressed = cards.filter((c) => c.el !== card);
						// 对称四舍五入（上下行为一致），并与让位曲线的 v >= 0.5 严格对应
						const shiftF = lastDy / slot;
						const p = Math.max(0, Math.min(h0 + Math.sign(shiftF) * Math.round(Math.abs(shiftF)), compressed.length));
						const ref = compressed[p] ? compressed[p].el : null;
						const lastCard = compressed.length ? compressed[compressed.length - 1].el : null;

						// FLIP 落位：先量每张卡片此刻的"视觉位置"；
						// 否则 DOM 重排后布局位置瞬间改变，而卡片还带着拖拽中的位移，
						// 整排会先炸开一格再滑回来 —— 就是归位那一瞬间的猛弹
						const flips = cards.map((c) => ({ el: c.el, from: c.el.getBoundingClientRect() }));

						if (ref) parent.insertBefore(card, ref);
						else if (lastCard && lastCard !== card) parent.insertBefore(card, lastCard.nextSibling);
						// 清掉拖拽中的位移，才能量到真正的最终布局位置
						for (const c of cards) {
							if (c.el === card) continue;
							c.el.style.transition = "";
							c.el.style.transform = "";
						}
						spacer.remove();
						restore();

						const moving = [];
						for (const item of flips) {
							const to = item.el.getBoundingClientRect();
							const dx = item.from.left - to.left;
							const dy = item.from.top - to.top;
							if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
							item.el.style.transition = "none";
							item.el.style.transform = `translate(${dx}px,${dy}px)`;
							moving.push(item.el);
						}
						if (moving.length) {
							void card.offsetHeight; // 强制提交起点，否则动画不跑、卡片瞬移
							for (const el of moving) {
								el.style.transition = "transform .26s cubic-bezier(.25,.8,.3,1)";
								el.style.transform = "";
								setTimeout(() => {
									el.style.transition = "";
								}, 300);
							}
						}
						// 保存要等落位动画走完：保存会触发设置页重排重绘，
						// 提前保存会把动画打断，卡片直接跳到位（就是那个突兀的跳变）
						setTimeout(() => {
							persist().finally(() => setTimeout(ensureHiddenLayout, 120));
						}, 320);
					} catch (e) {
						console.error(TAG, "落位失败：", e);
						try {
							if (spacer) spacer.remove();
						} catch {}
						try {
							restore();
						} catch {}
						try {
							persist();
						} catch {}
					}
				};

				document.addEventListener("pointermove", onMove, true);
				document.addEventListener("pointerup", finish, true);
				document.addEventListener("pointercancel", finish, true);
			}

			function request(method) {
				const names = collectCards().map(cardName).filter(Boolean);
				console.log(TAG, "保存顺序：", names);
				const init =
					method === "POST"
						? {
								method: "POST",
								headers: { "content-type": "application/json" },
								body: JSON.stringify({ names })
							}
						: { method: "GET" };
				const url = method === "POST" ? ENDPOINT : ENDPOINT + "?names=" + encodeURIComponent(JSON.stringify(names));
				return fetch(url, init).then((r) => r.json().catch(() => ({ ok: false, error: "HTTP " + r.status })).then((body) => ({ ok: r.ok, body })));
			}

			async function persist() {
				let last = null;
				for (const method of ["POST", "GET"]) {
					try {
						const out = await request(method);
						last = out;
						console.log(TAG, method, out);
						if (out.ok && out.body && out.body.ok !== false) {
							toast(out.body.runtime === false ? "已保存，重启后生效" : "顺序已生效", false);
							return;
						}
					} catch (err) {
						last = { ok: false, body: { error: String(err && err.message ? err.message : err) } };
						console.warn(TAG, method + " 失败", err);
					}
				}
				const detail = last && last.body && last.body.error ? last.body.error : "接口无响应";
				toast("没能写回配置：" + detail, true);
			}

			// ---------- 隐藏 ----------
			async function refreshHidden() {
				try {
					const out = await fetch("/dsh-models-sort/hidden").then((r) => r.json());
					if (out && out.ok) {
						const set = new Set();
						for (const e of out.entries || []) {
							set.add(normName(e.display));
							set.add(normName(e.key));
						}
						hiddenNames = set;
						hiddenReady = true;
						return true;
					}
				} catch (err) {
					console.warn(TAG, "读取隐藏列表失败", err);
				}
				return false;
			}

			function isHidden(card) {
				const n = normName(cardName(card));
				return Boolean(n) && hiddenNames.has(n);
			}

			function applyHidden(card) {
				const hidden = isHidden(card);
				card.classList.toggle("dsh-ms-hidden", hidden);
				const btn = card.querySelector("[" + HIDE_ATTR + "]");
				if (btn) {
					const label = hidden ? "显示" : "隐藏";
					if (btn.textContent !== label) btn.textContent = label;
				}
			}

			/** 隐藏的卡片挪到列表尾部，插一根"已隐藏"分隔条；位置没变就不动，免得触发无限重绘 */
			function ensureHiddenLayout() {
				if (dragging) return;
				const cards = collectCards();
				if (!cards.length) return;
				const parent = cards[0].parentElement;
				if (!parent) return;
				const add = findAddButton();
				const anchor = add && add.parentElement === parent ? add : null;
				const hiddenCards = cards.filter((c) => isHidden(c));

				// 从尾部往前校正：每张只在放错位时才挪
				let cursor = anchor;
				for (let i = hiddenCards.length - 1; i >= 0; i -= 1) {
					const c = hiddenCards[i];
					if (c.nextSibling === cursor) {
						cursor = c;
						continue;
					}
					parent.insertBefore(c, cursor);
					cursor = c;
				}

				let divider = parent.querySelector("." + DIVIDER_CLASS);
				if (!hiddenCards.length) {
					if (divider) divider.remove();
				} else {
					if (!divider) {
						divider = document.createElement("div");
						divider.className = DIVIDER_CLASS;
						divider.textContent = "已隐藏";
					}
					if (divider.nextSibling !== hiddenCards[0]) parent.insertBefore(divider, hiddenCards[0]);
				}
				for (const card of cards) applyHidden(card);
			}

			async function toggleHide(card) {
				const name = cardName(card);
				if (!name) return;
				const nowHidden = !isHidden(card);
				try {
					const out = await fetch("/dsh-models-sort/hidden", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ names: [name], hide: nowHidden })
					}).then((r) => r.json());
					if (!out || out.ok === false) {
						toast("没能保存隐藏状态：" + ((out && out.error) || "接口无响应"), true);
						return;
					}
					await refreshHidden();
					ensureHiddenLayout();
					toast(nowHidden ? "已隐藏，聊天框模型选择器不再显示" : "已恢复显示", false);
				} catch (err) {
					toast("没能保存隐藏状态：" + String(err && err.message ? err.message : err), true);
				}
			}

			// ---------- 同步 ----------
			function decorate(card) {
				if (!card.hasAttribute(CARD_ATTR)) card.setAttribute(CARD_ATTR, "1");
				if (card.dataset.dshMsPad === undefined) {
					const pad = parseFloat(getComputedStyle(card).paddingLeft) || 0;
					card.dataset.dshMsPad = String(pad);
					if (getComputedStyle(card).position === "static") card.style.position = "relative";
				}
				const want = Number(card.dataset.dshMsPad) + 20;
				if (Math.abs((parseFloat(getComputedStyle(card).paddingLeft) || 0) - want) > 0.5) {
					card.style.paddingLeft = want + "px";
				}
				if (!card.querySelector("[" + HANDLE_ATTR + "]")) {
					const handle = document.createElement("span");
					handle.className = "dsh-ms-handle";
					handle.setAttribute(HANDLE_ATTR, "");
					handle.setAttribute("role", "button");
					handle.setAttribute("aria-label", "拖动排序");
					handle.setAttribute("title", "拖动排序");
					handle.textContent = "⠿";
					handle.addEventListener("pointerdown", onPointerDown);
					card.appendChild(handle);
				}
				if (!card.querySelector("[" + HIDE_ATTR + "]")) {
					const buttons = [...card.querySelectorAll("button,[role='button']")];
					const del = buttons.find((b) => buttonText(b) === "删除");
					const edit = buttons.find((b) => buttonText(b) === "编辑");
					const actions = del ? del.parentElement : null;
					if (actions) {
						// 克隆"编辑"按钮，外观/悬停/圆角完全一致，只换文字和行为
						const btn = edit ? edit.cloneNode(false) : document.createElement("button");
						btn.setAttribute(HIDE_ATTR, "");
						btn.removeAttribute("id");
						btn.removeAttribute("name");
						if (!edit) {
							btn.type = "button";
							btn.className = "dsh-ms-hide-fallback";
						}
						btn.textContent = "隐藏";
						btn.setAttribute("aria-label", "隐藏");
						btn.setAttribute("title", "隐藏后聊天框模型选择器不再显示，设置页保留可恢复");
						btn.addEventListener("pointerdown", (e) => e.stopPropagation());
						btn.addEventListener("click", (e) => {
							e.preventDefault();
							e.stopPropagation();
							toggleHide(card);
						});
						actions.insertBefore(btn, actions.firstChild);
					}
				}
				applyHidden(card);
			}

			function sync() {
				const cards = collectCards();
				if (cards.length < 2) return;
				const keep = new Set(cards);
				for (const el of document.querySelectorAll("[" + CARD_ATTR + "]")) {
					if (keep.has(el)) continue;
					const handle = el.querySelector("[" + HANDLE_ATTR + "]");
					if (handle) handle.remove();
					const hideBtn = el.querySelector("[" + HIDE_ATTR + "]");
					if (hideBtn) hideBtn.remove();
					el.removeAttribute(CARD_ATTR);
					el.style.paddingLeft = "";
					delete el.dataset.dshMsPad;
				}
				for (const card of cards) decorate(card);
				if (!hiddenReady) {
					refreshHidden().then(() => ensureHiddenLayout());
					return;
				}
				ensureHiddenLayout();
			}

			function Sorter() {
				react.useEffect(() => {
					ensureStyle();
					let timer = 0;
					let disposed = false;
					const run = () => {
						if (disposed) return;
						clearTimeout(timer);
						timer = setTimeout(() => {
							try {
								sync();
							} catch (err) {
								console.warn(TAG, "sync 失败", err);
							}
						}, 120);
					};
					run();
					const observer = new MutationObserver(run);
					observer.observe(document.body, { childList: true, subtree: true });
					return () => {
						disposed = true;
						clearTimeout(timer);
						observer.disconnect();
					};
				}, []);
				return null;
			}

			function apply(ctx) {
				try {
					ctx.slots.inject("shell.overlay", function* () {
						yield ctx.slots.register({ name: "shell.overlay", id: "models-sort", order: 2000 }, () => h(Sorter, {}));
					});
				} catch (err) {
					console.warn(TAG, "挂载失败", err);
				}
			}

			try {
				window.__dshModelsSort = { sync, collectCards, cardName, persist, toggleHide, ensureHiddenLayout, refreshHidden, version: "0.3.0" };
			} catch {}

			return { apply, inject, name };
		};
	}

	window.__ModuleLoader__.load({ id: "dsh-models-sort", factory: makeFactory() });
})();
