/**
 * 自愈式 hosts 更新器 — 解决 github.com 被运营商 DNS 劫持导致的 IP 失效问题
 *
 * 原理：
 *   运营商在 UDP 53 端口做透明 DNS 劫持，返回的 IP 随机且部分已失效。
 *   本脚本直接测试一批候选 IP（来自多个公共 DNS 的解析结果），
 *   找到 TLS 证书确实属于 github.com 且延迟最低的那一个，写入 hosts。
 *
 * 用法（管理员 PowerShell）：
 *   node scripts/fix-github-hosts.mjs
 *   node scripts/fix-github-hosts.mjs --check    # 只测不改
 *   node scripts/fix-github-hosts.mjs --domains api.github.com,github.com
 *
 * 退出码：0 = hosts 正确 / 已修复；1 = 所有候选 IP 不可用
 */

import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import tls from 'node:tls';

// ---------- 配置 ----------

const HOSTS_PATH = process.platform === 'win32'
  ? 'C:\\Windows\\System32\\drivers\\etc\\hosts'
  : '/etc/hosts';

// 候选 IP 来自多轮实测 + 多家公共 DNS 解析结果，定期补充
const CANDIDATES = [
  '20.205.243.166',   // 8.8.8.8 / 223.5.5.5 常返，多次验证可用
  '20.247.166.64',    // 114.114.114.114 常返，验证可用
  '20.169.109.160',   // 1.1.1.1 常返，验证可用
  '20.27.177.113',    // 备用
  '20.200.245.247',   // 备用
  '20.233.83.145',    // 备用
  '4.236.95.112',     // 备用（间歇可用）
  '20.205.243.168',   // api.github.com 常用 IP
];

const DOMAINS_DEFAULT = ['github.com', 'www.github.com'];
const TIMEOUT_MS = 5000;
const EXPECTED_CN = /^(\*\.)?github\.com$/i;

// ---------- 解析参数 ----------

function parseArgs() {
  const args = process.argv.slice(2);
  const check = args.includes('--check');
  const di = args.indexOf('--domains');
  const domains = di >= 0 && args[di + 1]
    ? args[di + 1].split(',').map(s => s.trim()).filter(Boolean)
    : DOMAINS_DEFAULT;
  return { check, domains };
}

// ---------- IP 测试 ----------

function tcpConnect(host, port = 443) {
  return new Promise(resolve => {
    const t0 = Date.now();
    const sock = net.connect({ host, port, timeout: TIMEOUT_MS });
    sock.on('connect', () => { sock.destroy(); resolve({ ok: true, ms: Date.now() - t0 }); });
    sock.on('timeout', () => { sock.destroy(); resolve({ ok: false }); });
    sock.on('error', () => { sock.destroy(); resolve({ ok: false }); });
  });
}

function tlsVerify(ip, sni) {
  return new Promise(resolve => {
    const sock = tls.connect({
      host: ip,
      port: 443,
      servername: sni,
      timeout: TIMEOUT_MS,
      rejectUnauthorized: true,
    }, () => {
      const cert = sock.getPeerCertificate();
      const san = cert.subjectaltname || '';
      const cn = cert.subject?.CN || '';
      const valid = EXPECTED_CN.test(cn) || san.includes('github.com');
      sock.destroy();
      resolve({ valid, cn });
    });
    sock.on('timeout', () => { sock.destroy(); resolve({ valid: false }); });
    sock.on('error', () => { sock.destroy(); resolve({ valid: false }); });
  });
}

async function testIP(ip, sni) {
  const tcp = await tcpConnect(ip);
  if (!tcp.ok) return { ip, ok: false, reason: 'TCP 超时' };

  const cert = await tlsVerify(ip, sni);
  if (!cert.valid) return { ip, ok: false, reason: `TLS 证书不匹配: ${cert.cn || '(无CN)'}` };

  return { ip, ok: true, ms: tcp.ms, cn: cert.cn };
}

// ---------- hosts 文件读写 ----------

function readHosts() {
  return fs.readFileSync(HOSTS_PATH, 'utf-8');
}

function writeHosts(content) {
  fs.writeFileSync(HOSTS_PATH, content, 'utf-8');
}

/**
 * 用新 IP 替换（或追加）指定域名的 hosts 条目。
 * 保留所有其他行不变。
 */
function updateHostsLine(content, domain, ip) {
  const lines = content.split(/\r?\n/);
  const pattern = new RegExp(`^\\s*([\\d.]+)\\s+${domain.replace(/\./g, '\\.')}\\s*$`, 'i');
  let found = false;

  for (let i = 0; i < lines.length; i++) {
    if (pattern.test(lines[i])) {
      lines[i] = `${ip} ${domain}`;
      found = true;
      break;
    }
  }
  if (!found) {
    // 在末尾追加（保留原有空行格式）
    if (lines.length && lines[lines.length - 1].trim()) lines.push('');
    lines.push(`${ip} ${domain}`);
  }
  return lines.join('\n');
}

function getHostsIP(content, domain) {
  const pattern = new RegExp(`^\\s*([\\d.]+)\\s+${domain.replace(/\./g, '\\.')}\\s*$`, 'i');
  for (const line of content.split(/\r?\n/)) {
    const m = pattern.exec(line);
    if (m) return m[1];
  }
  return null;
}

// ---------- 主流程 ----------

async function main() {
  const { check, domains } = parseArgs();
  const primaryDomain = domains[0] || 'github.com';

  console.log(`目标域名: ${domains.join(', ')}`);
  console.log(`候选 IP: ${CANDIDATES.length} 个`);
  console.log('');

  // 1. 测试所有候选 IP
  console.log('测试候选 IP...');
  const results = [];
  for (const ip of CANDIDATES) {
    const r = await testIP(ip, primaryDomain);
    results.push(r);
    const tag = r.ok ? `✓ ${r.ms}ms` : `✗ ${r.reason}`;
    console.log(`  ${ip.padEnd(18)} ${tag}`);
  }

  const good = results.filter(r => r.ok).sort((a, b) => a.ms - b.ms);
  console.log('');

  if (good.length === 0) {
    console.error('✗ 所有候选 IP 不可用，无法修复。');
    console.error('  建议：稍后重试，或手动往 scripts/fix-github-hosts.mjs 的 CANDIDATES 里补充新 IP。');
    process.exit(1);
  }

  const best = good[0];
  console.log(`最优 IP: ${best.ip} (${best.ms}ms, ${best.cn})`);

  // 2. 读 hosts，检查是否需要更新
  let content = readHosts();
  let changed = false;

  for (const domain of domains) {
    const current = getHostsIP(content, domain);
    const needsUpdate = current !== best.ip;

    if (needsUpdate) {
      content = updateHostsLine(content, domain, best.ip);
      changed = true;
      console.log(`  ${domain}: ${current || '(未配置)'} → ${best.ip}`);
    } else {
      console.log(`  ${domain}: ${current} (已是最新)`);
    }
  }

  if (check) {
    console.log('\n(--check 模式，未写入)');
    process.exit(changed ? 1 : 0);
  }

  if (changed) {
    try {
      writeHosts(content);
      console.log(`\n✓ hosts 已更新 (${HOSTS_PATH})`);
    } catch (e) {
      console.error(`\n✗ 写入失败: ${e.message}`);
      console.error('  请以管理员身份运行本脚本。');
      process.exit(1);
    }
  } else {
    console.log('\n✓ hosts 无需修改，当前已是最优 IP');
  }

  // 3. 刷新 DNS 缓存
  if (process.platform === 'win32') {
    try {
      execFileSync('ipconfig', ['/flushdns'], { stdio: 'ignore' });
      console.log('✓ DNS 缓存已刷新');
    } catch { /* 非管理员也能刷新，失败不致命 */ }
  }

  process.exit(0);
}

main().catch(e => { console.error('未预期错误:', e); process.exit(1); });
