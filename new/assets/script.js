/* ═══════ GRAIN TEXTURE ═══════ */
(function(){
  function start(){
    const c=document.getElementById('grain');if(!c)return;
    const ctx=c.getContext('2d');
    const SC=3;let W,H;
    function resize(){W=Math.ceil(window.innerWidth/SC);H=Math.ceil(window.innerHeight/SC);c.width=W;c.height=H;c.style.width='100vw';c.style.height='100vh';}
    resize();window.addEventListener('resize',resize,{passive:true});
    let last=0;
    function tick(ts){
      if(ts-last>90){
        last=ts;
        const id=ctx.createImageData(W,H),d=id.data;
        for(let i=0;i<d.length;i+=4){const v=(Math.random()*255)|0;d[i]=d[i+1]=d[i+2]=v;d[i+3]=(Math.random()*14)|0;}
        ctx.putImageData(id,0,0);
      }
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }
  if('requestIdleCallback' in window){requestIdleCallback(start,{timeout:2000});}else{setTimeout(start,800);}
})();

/* ═══════ BACKGROUND BLOB PARALLAX ═══════ */
(function(){
  if(window.matchMedia('(prefers-reduced-motion: reduce)').matches)return;
  const blobs=document.querySelectorAll('.blob');
  if(!blobs.length)return;
  let ticking=false;
  window.addEventListener('scroll',()=>{
    if(ticking)return;ticking=true;
    requestAnimationFrame(()=>{
      const y=window.scrollY;
      blobs.forEach((b,i)=>{ b.style.marginTop=(y*(0.04+i*0.02))+'px'; });
      ticking=false;
    });
  },{passive:true});
})();

/* ═══════ SCROLL REVEAL ═══════ */
(function(){
  const els=document.querySelectorAll('.r');
  if(!els.length)return;
  const io=new IntersectionObserver(entries=>{
    entries.forEach(e=>{
      if(e.isIntersecting){e.target.classList.add('in');io.unobserve(e.target);}
    });
  },{threshold:.08,rootMargin:'0px 0px -40px 0px'});
  els.forEach(el=>io.observe(el));
})();

/* ═══════ FAQ ACCORDION ═══════ */
document.querySelectorAll('.faq-item').forEach(item=>{
  const q=item.querySelector('.faq-q');
  if(!q)return;
  q.addEventListener('click',()=>{
    const open=item.classList.contains('open');
    document.querySelectorAll('.faq-item.open').forEach(i=>i.classList.remove('open'));
    if(!open)item.classList.add('open');
  });
});

/* ═══════ SERVICE DROPDOWN ═══════ */
(function(){
  const item=document.querySelector('.h-item.has-drop');
  if(!item)return;
  const drop=item.querySelector('.svc-drop');
  let timer;
  item.addEventListener('mouseenter',()=>{clearTimeout(timer);drop.classList.add('open');});
  item.addEventListener('mouseleave',()=>{timer=setTimeout(()=>drop.classList.remove('open'),120);});
})();

/* ═══════ HAMBURGER MENU ═══════ */
(function(){
  const btn=document.getElementById('h-burger'),nav=document.getElementById('mob-nav');
  if(!btn||!nav)return;
  function close(){nav.classList.remove('open');btn.classList.remove('open');document.body.style.overflow='';}
  btn.addEventListener('click',()=>{
    const open=nav.classList.toggle('open');
    btn.classList.toggle('open',open);
    document.body.style.overflow=open?'hidden':'';
  });
  nav.querySelectorAll('.mob-link,.mob-sublink,.mob-cta-btn').forEach(a=>a.addEventListener('click',close));
})();

/* ═══════ MAGNETIC BUTTON ═══════ */
(function(){
  if(!window.matchMedia('(hover:hover) and (pointer:fine)').matches)return;
  document.querySelectorAll('[data-magnetic]').forEach(btn=>{
    btn.addEventListener('mousemove',e=>{
      const r=btn.getBoundingClientRect();
      const x=(e.clientX-r.left-r.width/2)*.28;
      const y=(e.clientY-r.top-r.height/2)*.28;
      btn.style.transform=`translate(${x}px,${y}px)`;
    });
    btn.addEventListener('mouseleave',()=>{btn.style.transform='';});
  });
})();
