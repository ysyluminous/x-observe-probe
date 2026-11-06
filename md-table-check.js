// README 表格完整性：按「连续行 = 同一张表」分组，列数以分隔行（| --- |）为准
const fs = require('fs');
const esc = String.fromCharCode(92) + '|';
const cellsOf = (l) => l.split(esc).join('@@').split('|');

function check(lines) {
  const bad = [];
  let tables = 0, rowsChecked = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].indexOf('| ') !== 0) continue;
    const block = [];
    while (i < lines.length && lines[i].indexOf('| ') === 0) block.push(i++);
    tables++;
    const sep = block.find((n) => /^\|[\s-|]+$/.test(lines[n]));
    if (sep === undefined) continue;
    const want = cellsOf(lines[sep]).length;
    block.forEach((n) => {
      rowsChecked++;
      if (cellsOf(lines[n]).length !== want) bad.push(n + 1);
    });
  }
  return { bad, tables, rowsChecked };
}

const path = process.argv[2] || 'skills/docs/README.md';
const lines = fs.readFileSync(path, 'utf8').split(/\r?\n/);
const r = check(lines);
r.bad.forEach((n) => console.log('破损：行 ' + n + ' 列数与分隔行不符 -> ' + lines[n - 1].slice(0, 40)));
console.log(r.bad.length === 0 ? '表格 OK：' + r.tables + ' 张表 / ' + r.rowsChecked + ' 行列数全对'
  : r.bad.length + ' 行破损（' + r.tables + ' 张表 / ' + r.rowsChecked + ' 行）');

// 反向对照：往第一张表的某一行塞一个裸 |，同一条判据必须多报一行
const first = lines.findIndex((l) => l.indexOf('| ') === 0);
const injAt = lines.findIndex((l, i) => i > first && l.indexOf('| ') === 0 && !/^\|[\s-|]+$/.test(l));
const mutated = lines.slice();
const before = mutated[injAt];
mutated[injAt] = before.slice(0, 30) + ' 裸竖线 | 测试 ' + before.slice(30);
if (mutated[injAt] === before) { console.log('BREAK FAILED：注入没改掉任何东西，上面结论别信'); process.exit(1); }
const r2 = check(mutated);
console.log('反向对照：注入一个裸 | 后破损行数 =', r2.bad.length, '（原文为', r.bad.length + '）->',
  r2.bad.length > r.bad.length ? '判据咬住了' : '判据没咬住，上面那个 OK 别信');
if (r2.bad.length <= r.bad.length) process.exit(1);
