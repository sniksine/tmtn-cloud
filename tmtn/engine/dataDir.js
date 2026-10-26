// 云端多用户补丁：数据目录可用 TMTN_DATA_DIR 指定（每个访客一个目录）；不设时与原版一样用项目根目录下的 data/
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = process.env.TMTN_DATA_DIR ? path.resolve(process.env.TMTN_DATA_DIR) : path.join(root, 'data');
try { mkdirSync(DATA_DIR, { recursive: true }); } catch {}
export const dataPath = (name = '') => path.join(DATA_DIR, name);
export const dataUrl = (name = '') => pathToFileURL(path.join(DATA_DIR, name) + (name === '' || name.endsWith('/') ? '/' : ''));
