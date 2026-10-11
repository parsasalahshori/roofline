import 'dotenv/config';
import { createApp } from './app.ts';
const host=process.env.HOST??'127.0.0.1',demo=process.env.DEMO_MODE!=='false';
if(demo&&!['127.0.0.1','localhost','::1'].includes(host))throw Error('Demo mode may only bind to loopback.');
const {app,store,jobs}=createApp({databasePath:process.env.DATABASE_PATH??'./data/roofline.sqlite',demo,adminEmail:process.env.ADMIN_EMAIL??'owner@example.com',adminPassword:process.env.ADMIN_PASSWORD,apiToken:process.env.API_TOKEN,production:process.env.NODE_ENV==='production'});
const server=app.listen(Number(process.env.PORT??4311),host,()=>console.log(`Roofline API running at http://${host}:${process.env.PORT??4311} (${demo?'demo':'authenticated'} mode)`));
const timer=setInterval(()=>jobs.poll().catch(()=>console.error('Report worker failed')),60000);timer.unref();
const stop=()=>{clearInterval(timer);server.close(()=>process.exit(0));};
process.on('SIGINT',stop);process.on('SIGTERM',stop);
