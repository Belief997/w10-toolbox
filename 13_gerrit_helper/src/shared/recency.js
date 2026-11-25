'use strict';

// 给 Gerrit 查询加上"只看最近 N 天"的过滤。
//
// 用 after:YYYY-MM-DD —— Gerrit 各版本都认的操作符（age:/since: 在旧版本里
// 语义有过变化）。用户查询里已经写了 after:/before: 的不再重复加，免得把
// 自己的条件顶掉。

const HAS_DATE_FILTER = /\b(after|before|since|until|age)\s*:/i;

function formatDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function withRecency(query, days, now = Date.now()) {
  const text = String(query || '').trim();
  const value = Number(days);
  if (!text || !Number.isFinite(value) || value <= 0) return text;
  if (HAS_DATE_FILTER.test(text)) return text;
  const since = new Date(now - value * 86400000);
  return `${text} after:${formatDate(since)}`;
}

module.exports = { HAS_DATE_FILTER, formatDate, withRecency };
