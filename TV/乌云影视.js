// @name 乌云影视
// @author nexu-agent
// @version 2.0.0
// @description 刮削：不支持，弹幕：不支持，嗅探：不支持

/**
 * ============================================================================
 * 乌云影视 (wooyun.tv) - OmniBox 爬虫脚本
 * ============================================================================
 * 站点基于 Next.js + 自建 API，播放地址为 CloudFront CDN 直链
 *
 * 已验证 API：
 *   首页：GET /movie/media/home/custom/classify/1/3?limit=12
 *   搜索：POST /movie/media/search  body:{keyword,pageIndex,pageSize}
 *   详情：GET /movie/media/base/detail?mediaId={id}
 *   剧集：GET /movie/media/video/list?mediaId={id}  → 返回含 playUrl 的直链
 * ============================================================================
 */

const OmniBox = require("omnibox_sdk");

// ==================== 配置 ====================
const HOST = "https://wooyun.tv";
const API = "https://wooyun.tv/movie";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const HEADERS = {
  "User-Agent": UA,
  "Accept": "application/json",
  "Content-Type": "application/json",
  "Referer": HOST + "/",
  "Origin": HOST
};

// 分类
const CLASSES = [
  { type_id: "movie", type_name: "电影" },
  { type_id: "tv_series", type_name: "电视剧" },
  { type_id: "short_drama", type_name: "短剧" },
  { type_id: "animation", type_name: "动画" },
  { type_id: "variety", type_name: "综艺" }
];

// ==================== 日志 ====================
const log = (level, msg) => OmniBox.log(level, `[乌云] ${msg}`);

// ==================== 请求封装 ====================
async function httpGet(path) {
  const url = path.startsWith("http") ? path : `${API}${path}`;
  const res = await OmniBox.request(url, { method: "GET", headers: HEADERS, timeout: 15000 });
  if (res.statusCode !== 200) throw new Error(`HTTP ${res.statusCode}`);
  return JSON.parse(res.body);
}

async function httpPost(path, body) {
  const url = path.startsWith("http") ? path : `${API}${path}`;
  const res = await OmniBox.request(url, {
    method: "POST", headers: HEADERS, body: JSON.stringify(body), timeout: 15000
  });
  if (res.statusCode !== 200) throw new Error(`HTTP ${res.statusCode}`);
  return JSON.parse(res.body);
}

// ==================== 格式化 ====================
function formatVideo(item) {
  return {
    vod_id: String(item.id),
    vod_name: item.title || "",
    vod_pic: item.posterUrlS3 || item.posterUrl || "",
    vod_remarks: item.episodeStatus || ""
  };
}

/**
 * 将 wooyun 的 videoList 转换为 OmniBox 的 vod_play_sources 格式
 * 这是实现选集功能的关键！
 */
function convertToPlaySources(seasons) {
  if (!seasons || !seasons.length) return [];

  const sources = [];

  for (const season of seasons) {
    const videos = season.videoList || [];
    if (!videos.length) continue;

    const lineName = season.seasonNo ? `第${season.seasonNo}季` : "正片";

    const episodes = videos.map(ep => ({
      name: ep.remark || `第${ep.epNo || 0}集`,
      playId: ep.playUrl || ""
    }));

    sources.push({
      name: lineName,
      episodes: episodes
    });
  }

  return sources;
}

// ==================== 接口实现 ====================

/**
 * 首页
 */
async function home(params) {
  try {
    const res = await httpGet("/media/home/custom/classify/1/3?limit=12");
    const records = (res.data?.records) || [];

    const list = records.flatMap(section =>
      (section.mediaResources || []).map(item => ({
        vod_id: String(item.id),
        vod_name: item.mediaName || "",
        vod_pic: item.posterUrlS3 || item.posterUrl || "",
        vod_remarks: item.episodeStatus || ""
      }))
    );

    return { class: CLASSES, list };
  } catch (e) {
    log("error", `首页失败: ${e.message}`);
    return { class: CLASSES, list: [] };
  }
}

/**
 * 分类
 * wooyun 没有独立分类列表 API，使用搜索接口 + 按 mediaType 过滤
 */
async function category(params) {
  const tid = params.categoryId || params.id || "";
  const pg = parseInt(params.page) || 1;
  try {
    const res = await httpPost("/media/search", { keyword: "", pageIndex: pg, pageSize: 30 });
    const data = res.data || {};
    const allRecords = data.records || [];

    const list = allRecords
      .filter(item => item.mediaType && item.mediaType.code === tid)
      .map(formatVideo);

    return { list, page: pg, pagecount: data.pages || pg, limit: 30 };
  } catch (e) {
    return { list: [], page: pg, pagecount: pg };
  }
}

/**
 * 搜索（客户端二次过滤）
 */
async function search(params) {
  const wd = (params.keyword || params.wd || "").trim();
  try {
    const allResults = [];
    for (let pg = 1; pg <= 5; pg++) {
      const res = await httpPost("/media/search", { keyword: wd, pageIndex: pg, pageSize: 50 });
      const records = res.data?.records || [];
      allResults.push(...records);
      if (!res.data?.pages || pg >= res.data.pages) break;
    }

    const filtered = wd
      ? allResults.filter(item =>
          (item.title || "").includes(wd) ||
          (item.originalTitle || "").toLowerCase().includes(wd.toLowerCase()) ||
          (item.actors || []).some(a => a && a.includes(wd)) ||
          (item.directors || []).some(d => d && d.includes(wd))
        )
      : allResults;

    return { list: filtered.map(formatVideo) };
  } catch (e) {
    return { list: [] };
  }
}

/**
 * 详情 —— 返回 vod_play_sources 实现选集
 */
async function detail(params) {
  const id = params.videoId || params.id;
  try {
    // 并发请求详情和剧集
    const [detailRes, videoRes] = await Promise.all([
      httpGet(`/media/base/detail?mediaId=${id}`),
      httpGet(`/media/video/list?mediaId=${id}`)
    ]);

    const info = detailRes.data || detailRes;
    const seasons = videoRes.data || [];

    // 转换为 vod_play_sources 格式（选集核心）
    const vodPlaySources = convertToPlaySources(seasons);

    return {
      list: [{
        vod_id: String(info.id),
        vod_name: info.title || "",
        vod_pic: info.posterUrlS3 || info.posterUrl || "",
        type_name: (info.mediaType || {}).name || "",
        vod_year: info.releaseYear ? String(info.releaseYear) : "",
        vod_area: info.region || "",
        vod_director: (info.directors || []).join(" "),
        vod_actor: (info.actors || []).join(" "),
        vod_content: info.overview || info.description || "",
        vod_remarks: info.episodeStatus || "",
        vod_play_sources: vodPlaySources.length > 0 ? vodPlaySources : undefined
      }]
    };
  } catch (e) {
    log("error", `详情失败: ${e.message}`);
    return { list: [] };
  }
}

/**
 * 播放 —— playId 就是 CDN 直链，直接播放
 */
async function play(params) {
  const playId = params.playId || "";
  try {
    if (!playId) {
      return { urls: [], parse: 0, header: {} };
    }

    // wooyun 的 playUrl 是 CloudFront CDN 直链 (.m3u8/.mp4)
    const isDirect = /\.(m3u8|mp4|flv|avi|mkv|ts)/i.test(playId);

    return {
      urls: [{ name: "乌云专线", url: playId }],
      parse: isDirect ? 0 : 1,
      header: isDirect ? {} : { "User-Agent": UA, "Referer": HOST }
    };
  } catch (e) {
    log("error", `播放失败: ${e.message}`);
    return { urls: [], parse: 0, header: {} };
  }
}

// ==================== 导出 ====================
module.exports = { home, category, search, detail, play };

const runner = require("spider_runner");
runner.run(module.exports);
