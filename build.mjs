import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url)) + path.sep;
const srcDir = dir + 'src' + path.sep;
const tpl = fs.readFileSync(srcDir + 'template.html', 'utf8');
const vocab = fs.readFileSync(srcDir + 'vocab.json', 'utf8').trim();

if (!tpl.includes('/*__DATA__*/null')) throw new Error('placeholder /*__DATA__*/null missing in template.html');

// 数据注入，并把脚本单独做一次语法解析：语法错误在构建阶段暴露，而不是等到浏览器里白屏
const out = tpl.replace('/*__DATA__*/null', vocab);
const script = out.slice(out.indexOf('<script>') + '<script>'.length, out.lastIndexOf('</script>'));
new Function('"use strict";' + script.replace(/^const DATA =/, 'var DATA ='));
const parsed = JSON.parse(vocab);

fs.writeFileSync(dir + 'root-learner.html', out, 'utf8');
console.log('built root-learner.html:', fs.statSync(dir + 'root-learner.html').size, 'bytes');
console.log('data:', parsed.roots.length, 'roots,', parsed.roots.reduce((a, r) => a + r.words.length, 0), 'words,', parsed.letters.length, 'letters');
console.log('syntax check: OK');
