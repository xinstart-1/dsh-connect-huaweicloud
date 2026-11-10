/**
 * 浏览器半边自检的测试。
 *
 * 只测「真实文件通过」等于没测：检查逻辑失效时它照样会打印 ok。所以每个检查都配一个
 * 构造出来的坏样本，断言它**被抓住**。
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  checkLocale,
  checkNoLiteralColors,
  checkNoModuleSyntax,
  checkRoutes,
  checkSyntax,
  dictionaryKeys,
  runAllChecks,
} from '../scripts/check-client.mjs';

const STATUS_PATH = '/plugins/dsh-connect-huaweicloud/status';
const ACTION_PATH = '/plugins/dsh-connect-huaweicloud/action';
const ROUTES = { statusPath: STATUS_PATH, actionPath: ACTION_PATH };

const source = await readFile(resolve('src/client/bundle.js'), 'utf8');

describe('真实文件', () => {
  test('全部检查通过', () => {
    const result = runAllChecks(source, ROUTES);
    assert.deepEqual(result.problems, [], `不该有问题：${result.problems.join('；')}`);
    assert.equal(result.ok, true);
  });

  test('zh 与 en 字典都被抽出来且键数相同', () => {
    const zh = dictionaryKeys(source, 'zh');
    const en = dictionaryKeys(source, 'en');
    assert.ok(zh.length > 20, `zh 键太少（${String(zh.length)}），字典抽取可能坏了`);
    assert.deepEqual([...zh].sort(), [...en].sort());
  });
});

describe('语法检查', () => {
  test('坏的语法被抓住', () => {
    const result = checkSyntax('var x = {;');
    assert.equal(result.ok, false);
    assert.ok(result.problems.some((problem) => problem.includes('语法错误')));
  });
});

describe('模块语法检查', () => {
  test('import 语句被抓住', () => {
    const result = checkNoModuleSyntax("import react from 'react';\nvar x = 1;");
    assert.equal(result.ok, false);
    assert.ok(result.problems.some((problem) => problem.includes('import')));
  });

  test('export 语句被抓住', () => {
    const result = checkNoModuleSyntax('var x = 1;\nexport const y = 2;');
    assert.equal(result.ok, false);
    assert.ok(result.problems.some((problem) => problem.includes('export')));
  });

  test('字符串里的 import 字样不算违规', () => {
    const result = checkNoModuleSyntax("var text = 'import and export are words';");
    assert.equal(result.ok, true, `不该误报：${result.problems.join('；')}`);
  });
});

describe('i18n 检查', () => {
  test('en 缺键被抓住', () => {
    // 只删 en 段里的键：`refresh` 在 zh 里也有，全局替换会误删 zh 那一份，
    // 那样测到的是「zh 缺键」而不是本用例要测的方向。
    const enStart = source.indexOf('var en = {');
    assert.ok(enStart > 0, '找不到 en 字典');
    const head = source.slice(0, enStart);
    const tail = source.slice(enStart).replace(/\n\s*refresh: '[^']*',/u, '\n');
    const result = checkLocale(head + tail);
    assert.equal(result.ok, false);
    assert.ok(
      result.problems.some((problem) => problem.includes('en 缺键')),
      `应报 en 缺键，实际：${result.problems.join('；')}`,
    );
  });

  test('t() 引用不存在的键被抓住', () => {
    const broken = source + "\nvar probe = t('thisKeyDoesNotExist');";
    const result = checkLocale(broken);
    assert.equal(result.ok, false);
    assert.ok(result.problems.some((problem) => problem.includes('thisKeyDoesNotExist')));
  });
});

describe('路由检查', () => {
  test('路由写错被抓住', () => {
    const broken = source.replace(STATUS_PATH, '/plugins/wrong-name/status');
    const result = checkRoutes(broken, STATUS_PATH, ACTION_PATH);
    assert.equal(result.ok, false);
    assert.ok(result.problems.some((problem) => problem.includes('不一致')));
  });

  test('缺动作路由被抓住', () => {
    const broken = source.replace(ACTION_PATH, '/plugins/other/action');
    const result = checkRoutes(broken, STATUS_PATH, ACTION_PATH);
    assert.equal(result.ok, false);
    assert.ok(result.problems.length > 0);
  });
});

describe('颜色检查', () => {
  test('真实文件没有字面色值', () => {
    const result = checkNoLiteralColors(source);
    assert.deepEqual(result.problems, [], `不该有字面色值：${result.problems.join('；')}`);
  });

  test('十六进制色值被抓住', () => {
    // 字面色值在深色主题下看着正常，切浅色才暴露；所以必须能被静态检出。
    // 插到 CSS 数组的**第一个元素之前**，确保落在数组内部。
    const broken = source.replace("var CSS = [\n", "var CSS = [\n    '.dshc-probe{color:#ff0000}',\n");
    assert.notEqual(broken, source, '样本构造失败：没找到 CSS 数组开头');
    const result = checkNoLiteralColors(broken);
    assert.equal(result.ok, false);
    assert.ok(
      result.problems.some((problem) => problem.includes('#ff0000')),
      `应抓住 #ff0000，实际：${result.problems.join('；')}`,
    );
  });

  test('rgb() 色值被抓住', () => {
    const broken = source.replace("var CSS = [\n", "var CSS = [\n    '.dshc-probe{background:rgba(0,0,0,.5)}',\n");
    assert.notEqual(broken, source, '样本构造失败：没找到 CSS 数组开头');
    const result = checkNoLiteralColors(broken);
    assert.equal(result.ok, false);
    assert.ok(
      result.problems.some((problem) => problem.includes('rgba(0,0,0,.5)')),
      `应抓住 rgba，实际：${result.problems.join('；')}`,
    );
  });
});
