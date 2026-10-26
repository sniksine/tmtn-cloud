// 手机版：窄屏时切换成「底部导航 + 单栏」布局（列表 / 行情 / 下单 / 记录），不改原有功能
(function () {
  const MQ = window.matchMedia('(max-width: 760px)');
  const body = document.body;
  const nav = document.createElement('nav');
  nav.className = 'mnav';
  nav.innerHTML = '<button data-mt="list"><i>☰</i>列表</button><button data-mt="chart"><i>📈</i>行情</button><button data-mt="trade"><i>⚡</i>下单</button><button data-mt="orders"><i>🧾</i>记录</button><a href="/_gw/"><i>☁</i>会话</a>';
  body.appendChild(nav);
  const setTab = (t) => {
    body.dataset.mt = t;
    nav.querySelectorAll('[data-mt]').forEach((b) => b.classList.toggle('on', b.dataset.mt === t));
    try { localStorage.mTab = t; } catch { /* 忽略 */ }
    // 回到交易视图
    if (body.dataset.mv !== 'trade') document.querySelector('#viewSw [data-view="trade"]')?.click();
    window.scrollTo(0, 0);
    setTimeout(() => window.dispatchEvent(new Event('resize')), 50);   // 让 K 线按新尺寸重绘
  };
  nav.addEventListener('click', (e) => { const b = e.target.closest('[data-mt]'); if (b) setTab(b.dataset.mt); });
  const syncView = () => {
    const a = document.querySelector('#viewSw button.active');
    body.dataset.mv = a?.dataset.view || 'trade';
  };
  new MutationObserver(syncView).observe(document.getElementById('viewSw'), { subtree: true, attributes: true, attributeFilter: ['class'] });
  const topH = () => { const h = document.querySelector('.topbar')?.offsetHeight || 0; const f = document.getElementById('favBar'); body.style.setProperty('--mTop', (h + (f && getComputedStyle(f).display !== 'none' ? f.offsetHeight : 0)) + 'px'); };
  const apply = () => {
    body.classList.toggle('m', MQ.matches);
    if (MQ.matches && !body.dataset.mt) { let t = 'list'; try { t = localStorage.mTab || 'list'; } catch { /* 忽略 */ } body.dataset.mt = t; nav.querySelectorAll('[data-mt]').forEach((b) => b.classList.toggle('on', b.dataset.mt === t)); }
    syncView(); topH();
  };
  MQ.addEventListener ? MQ.addEventListener('change', apply) : MQ.addListener(apply);
  window.addEventListener('resize', topH);
  apply();
  // 在列表里点了某个代币（地址栏里的 CA 变了）→ 自动跳到「行情」
  let lastCa = (location.hash.match(/0x[0-9a-fA-F]{40}/) || [''])[0].toLowerCase();
  const onRoute = () => {
    const ca = (location.hash.match(/0x[0-9a-fA-F]{40}/) || [''])[0].toLowerCase();
    if (ca && ca !== lastCa && body.classList.contains('m') && body.dataset.mt === 'list' && Date.now() - lastTap < 1500) setTab('chart');
    lastCa = ca;
  };
  let lastTap = 0;
  document.addEventListener('click', (e) => { if (e.target.closest('.layout > .left, .pulse')) lastTap = Date.now(); }, true);
  window.addEventListener('hashchange', onRoute);
  setInterval(onRoute, 500);   // 有些跳转用 history.replaceState，不触发 hashchange
})();
