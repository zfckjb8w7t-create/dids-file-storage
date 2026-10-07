// Matrix rain in cycling green/blue/purple, plus the self-typing glow title.
(function () {
  const canvas = document.getElementById('matrix');
  if (canvas) {
    const ctx = canvas.getContext('2d');
    const glyphs = 'ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾅﾆﾇﾈﾉ0123456789ABCDEF<>/{}[]#$%&*+='.split('');
    const palette = ['#39ff9e', '#4db8ff', '#b78bff']; // green / blue / purple
    let cols, drops, hues, fontSize, W, H, dpr;

    function resize() {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      W = canvas.width = Math.floor(innerWidth * dpr);
      H = canvas.height = Math.floor(innerHeight * dpr);
      canvas.style.width = innerWidth + 'px';
      canvas.style.height = innerHeight + 'px';
      fontSize = Math.max(14, Math.floor(16 * dpr));
      cols = Math.floor(W / fontSize);
      drops = new Array(cols).fill(0).map(() => Math.random() * -H / fontSize);
      hues = new Array(cols).fill(0).map(() => Math.floor(Math.random() * palette.length));
    }
    resize();
    addEventListener('resize', resize);

    let t = 0;
    function draw() {
      ctx.fillStyle = 'rgba(5,6,10,0.085)';
      ctx.fillRect(0, 0, W, H);
      ctx.font = fontSize + 'px "DejaVu Sans Mono", monospace';
      t++;
      for (let i = 0; i < cols; i++) {
        const x = i * fontSize;
        const y = drops[i] * fontSize;
        const ch = glyphs[(Math.random() * glyphs.length) | 0];
        // leading glyph bright white, trail in the column's hue
        const base = palette[hues[i]];
        ctx.fillStyle = base;
        ctx.shadowColor = base;
        ctx.shadowBlur = 8 * dpr;
        ctx.fillText(ch, x, y);
        ctx.shadowBlur = 0;
        if (Math.random() > 0.975) { ctx.fillStyle = '#ffffff'; ctx.fillText(ch, x, y); }
        if (y > H && Math.random() > 0.975) { drops[i] = 0; if (Math.random() > 0.7) hues[i] = (hues[i] + 1) % palette.length; }
        drops[i] += 0.45 + (i % 3) * 0.06;
      }
      requestAnimationFrame(draw);
    }
    draw();
  }

  // ---- self-typing + backspacing glow title ----
  const titleEl = document.getElementById('title4d');
  if (titleEl) {
    const full = 'Dids File Storage <3';
    let i = 0, dir = 1, hold = 0;
    function render(n) {
      const text = full.slice(0, n);
      // render with a highlighted heart, plus a caret
      const safe = text.replace('<3', '§HEART§')
        .replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace('§HEART§', '<span class="heart">&lt;3</span>');
      titleEl.innerHTML = safe + '<span class="caret">&nbsp;</span>';
    }
    function tick() {
      if (hold > 0) { hold--; return schedule(); }
      i += dir;
      render(i);
      if (i >= full.length) { dir = -1; hold = 18; }     // pause full
      else if (i <= 0) { dir = 1; hold = 10; }            // pause empty
      schedule();
    }
    function schedule() {
      const base = dir > 0 ? 115 : 55;                    // type slower than delete
      setTimeout(() => requestAnimationFrame(tick), base + Math.random() * 45);
    }
    render(0);
    schedule();
  }
})();
