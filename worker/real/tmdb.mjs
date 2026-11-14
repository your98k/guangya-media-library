/**
 * tmdb.mjs — TMDB 接口客户端（v3 api_key 方式，与示例 worker 一致）。
 *
 * 需要环境变量 TMDB_API_KEY（在 themoviedb.org 免费申请）。
 * 未配置时所有函数抛 ConfigMissing('TMDB_API_KEY')，由任务层如实回写失败。
 */

import { ConfigMissing } from './errors.mjs';

const TMDB_BASE = 'https://api.themoviedb.org/3';

function requireKey() {
  const key = process.env.TMDB_API_KEY || '';
  if (!key) throw new ConfigMissing('TMDB_API_KEY');
  return key;
}

export function tmdbConfigured() {
  return Boolean(process.env.TMDB_API_KEY);
}

async function tmdbGet(path, params = {}) {
  const key = requireKey();
  const qs = new URLSearchParams({ api_key: key, language: 'zh-CN', ...params });
  const r = await fetch(`${TMDB_BASE}${path}?${qs}`);
  if (!r.ok) throw new Error(`TMDB ${path} -> ${r.status}`);
  return r.json();
}

/** 海报完整地址；posterPath 为空返回 ''。size 可用 w185/w342/w500/original。 */
export function posterUrl(posterPath, size = 'w500') {
  return posterPath ? `https://image.tmdb.org/t/p/${size}${posterPath}` : '';
}

function normalize(item, mediaType) {
  return {
    tmdb_id: item.id,
    title: item.title || item.name || '',
    year: Number(String(item.release_date || item.first_air_date || '').slice(0, 4)) || null,
    media_type: mediaType,
    overview: item.overview || '',
    poster_url: posterUrl(item.poster_path),
    vote_average: item.vote_average ?? null,
  };
}

/** 按片名搜电视剧，返回面板搜索结果形状的数组（最多 20 条）。 */
export async function searchTv(title) {
  const d = await tmdbGet('/search/tv', { query: title });
  return (d.results || []).slice(0, 20).map((x) => normalize(x, 'tv'));
}

/** 按片名搜电影，返回面板搜索结果形状的数组（最多 20 条）。 */
export async function searchMovie(title) {
  const d = await tmdbGet('/search/movie', { query: title });
  return (d.results || []).slice(0, 20).map((x) => normalize(x, 'movie'));
}

/** 电视剧详情：季数、每季集数、总集数等（用于核对库内进度/待补集数）。 */
export async function tvDetails(tmdbId) {
  const d = await tmdbGet(`/tv/${tmdbId}`);
  return {
    tmdb_id: d.id,
    title: d.name || '',
    year: Number(String(d.first_air_date || '').slice(0, 4)) || null,
    status: d.status || '',
    number_of_seasons: d.number_of_seasons ?? null,
    number_of_episodes: d.number_of_episodes ?? null,
    seasons: (d.seasons || []).map((s) => ({
      season_number: s.season_number,
      episode_count: s.episode_count,
      air_date: s.air_date || null,
    })),
    poster_url: posterUrl(d.poster_path),
    overview: d.overview || '',
  };
}

/** 电影详情（单条）。 */
export async function movieDetails(tmdbId) {
  const d = await tmdbGet(`/movie/${tmdbId}`);
  return { ...normalize(d, 'movie'), status: d.status || '' };
}
