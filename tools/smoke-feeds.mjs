import WebSocket from 'ws';
// Honour DEPTHVIZ_URL like the other tools do: the deployed service listens on
// 8888, so a hardcoded 8787 made this report all 11 feeds dead while the server
// was perfectly healthy — a smoke test that cries wolf is worse than none.
const URL = process.env.DEPTHVIZ_URL || 'ws://127.0.0.1:8787/ws';
const combos = [
  ['okx','spot','BTC-USDT'], ['okx','perp','BTC-USDT-SWAP'],
  ['binance','spot','BTCUSDT'], ['binance','perp','BTCUSDT'],
  ['mexc','spot','BTCUSDT'], ['mexc','perp','BTC_USDT'],
  ['bitunix','spot','btcusdt'], ['bitunix','perp','BTCUSDT'],
  ['hyperliquid','spot','@107'], ['hyperliquid','perp','BTC'],
  ['coinbase','spot','BTC-USD'],
  ['aster','perp','BTCUSDT'], ['lighter','perp','BTC'],
];
const fmt=(n)=>n==null?'n/a':'$'+(n/1e6).toFixed(1)+'M';
const run = ([ex,mk,sym]) => new Promise((res)=>{
  const ws = new WebSocket(URL);
  let out={ex,mk,sym,books:0,status:[]};
  // sample late: 24h volume is fetched asynchronously after the first book
  const t=setTimeout(()=>{ws.close();res(out)},9000);
  ws.on('open',()=>ws.send(JSON.stringify({op:'subscribe',exchange:ex,market:mk,symbol:sym,range:2})));
  ws.on('message',(r)=>{const m=JSON.parse(r);
    if(m.op==='status'){out.status.push(m.state+(m.detail?`(${m.detail})`:''))}
    if(m.op==='book'){out.books++;
      {const mid=(m.bids[0][0]+m.asks[0][0])/2;
        const sum=(a)=>a.reduce((s,[p,q])=>s+p*q,0);
        const span=(a,s)=>a.length?((a[a.length-1][0]/mid-1)*100).toFixed(2)+'%':'-';
        out.res=`mid=${mid.toFixed(4)} lv=${m.levels[0]}/${m.levels[1]} sent=${m.bids.length}/${m.asks.length} span=${span(m.bids)}..${span(m.asks)} notional=${fmt(sum(m.bids))}/${fmt(sum(m.asks))} vol24=${fmt(m.vol24h)} src=${m.source} clock=${m.tsVenue == null ? 'none' : `venue+${m.tsRecv - m.tsVenue}ms`}`;}
    }});
  ws.on('error',e=>{out.err=`${e.message||e} (${URL})`;clearTimeout(t);res(out)});
});
for (const c of combos){const r=await run(c);
  console.log(`${(r.ex+'/'+r.mk).padEnd(18)} ${r.res||('FAIL books='+r.books+' '+(r.err||'')+' status='+r.status.join(','))}`);}
process.exit(0);
