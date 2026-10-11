import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Measurement, Quote, Company } from '../shared/types.ts';
import { defaultPricebook, type Pricebook } from '../shared/pricing.ts';

export class Store {
  db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), {recursive:true,mode:0o700});
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS measurements (id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS quotes (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, quote_id TEXT NOT NULL REFERENCES quotes(id), at TEXT NOT NULL, detail TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    if (!this.db.prepare('SELECT id FROM settings WHERE id=1').get()) this.saveSettings({company:{name:'Summit Roofing Co.',email:'',phone:'',address:'',license:'',proposalDays:30},pricebook:defaultPricebook});
  }
  settings() { return JSON.parse((this.db.prepare('SELECT json FROM settings WHERE id=1').get() as any).json) as {company:Company;pricebook:Pricebook}; }
  saveSettings(data: {company:Company;pricebook:Pricebook}) { this.db.prepare('INSERT INTO settings VALUES(1,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(JSON.stringify(data)); }
  measurement(id: string): Measurement | undefined { const row = this.db.prepare('SELECT json FROM measurements WHERE id=?').get(id) as any; return row ? JSON.parse(row.json) : undefined; }
  saveMeasurement(data: Measurement) { this.db.prepare('INSERT INTO measurements VALUES(?,?)').run(data.id,JSON.stringify(data)); return data; }
  quotes(): Quote[] { return (this.db.prepare('SELECT json FROM quotes ORDER BY seq DESC').all() as any[]).map(r=>JSON.parse(r.json)); }
  quote(id: string): Quote | undefined { const row = this.db.prepare('SELECT json FROM quotes WHERE id=?').get(id) as any; return row ? JSON.parse(row.json) : undefined; }
  createQuote(data: Omit<Quote,'number'>) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = this.db.prepare('INSERT INTO quotes(id,json) VALUES(?,?)').run(data.id,'{}');
      const quote = {...data,number:`RF-${String(result.lastInsertRowid).padStart(4,'0')}`};
      this.db.prepare('UPDATE quotes SET json=? WHERE id=?').run(JSON.stringify(quote),data.id);
      this.event(data.id,'Draft created'); this.db.exec('COMMIT'); return quote;
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  updateQuote(quote: Quote, event: string) {
    this.db.exec('BEGIN IMMEDIATE');
    try { this.db.prepare('UPDATE quotes SET json=? WHERE id=?').run(JSON.stringify(quote),quote.id); this.event(quote.id,event); this.db.exec('COMMIT'); return quote; }
    catch(e) {this.db.exec('ROLLBACK'); throw e;}
  }
  event(id: string, detail: string) { this.db.prepare('INSERT INTO events VALUES(?,?,?,?)').run(randomUUID(),id,new Date().toISOString(),detail); }
  events(id: string) {return this.db.prepare('SELECT at,detail FROM events WHERE quote_id=? ORDER BY at DESC').all(id);}
  close() { this.db.close(); }
}
