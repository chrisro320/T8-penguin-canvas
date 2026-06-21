import type { GenerateExternalVideoRequest } from '../services/generation';
import type { MediaMention } from '../components/nodes/mediaMentions';

export type TimelineDirectorLlmMode = 'segment' | 'full';

export interface TimelineDirectorBlockInput {
  id?: string;
  title?: string;
  imageUrl?: string;
  imageName?: string;
  /** Legacy field kept only so older canvases can load. It is not sent to Jimeng. */
  imageRole?: unknown;
  prompt?: string;
  mentions?: MediaMention[];
  durationSec?: number;
}

export interface TimelineDirectorBlock {
  id: string;
  title: string;
  imageUrl: string;
  imageName: string;
  mentionToken: string;
  prompt: string;
  mentions: MediaMention[];
  durationSec: number;
}

export interface TimelineDirectorRequestOptions {
  providerId: string;
  providerModel?: string;
  model?: string;
  aspectRatio?: string;
  resolution?: string;
  generateAudio?: boolean;
  seed?: number;
  globalPrompt?: string;
  /** Legacy field kept so older callers/tests can pass it; ignored by timeline director. */
  globalStyle?: unknown;
  referenceImages?: string[];
  videos?: string[];
  audios?: string[];
  providerParams?: Record<string, any>;
}

export interface TimelineDirectorCompiledSegment {
  index: number;
  fromToken: string;
  toToken: string;
  durationSec: number;
  description: string;
  prompt: string;
}

export interface TimelineDirectorAgentShotPlanInput {
  title?: string;
  imageName?: string;
  prompt?: string;
  imagePrompt?: string;
  durationSec?: number;
}

export interface TimelineDirectorAgentShotPlan {
  title: string;
  imageName: string;
  prompt: string;
  imagePrompt: string;
  durationSec: number;
}

export interface TimelineDirectorAgentPlan {
  globalPrompt: string;
  shots: TimelineDirectorAgentShotPlan[];
}

export const TIMELINE_DIRECTOR_MIN_SEGMENT_DURATION_SEC = 1;
export const TIMELINE_DIRECTOR_MAX_SEGMENT_DURATION_SEC = 12;
export const TIMELINE_DIRECTOR_MIN_TOTAL_DURATION_SEC = 4;
export const TIMELINE_DIRECTOR_MAX_TOTAL_DURATION_SEC = 15;

function cleanText(value: unknown, max = 240): string {
  return typeof value === 'string'
    ? value.replace(/\s+/g, ' ').trim().slice(0, max)
    : '';
}

function cleanStringArray(value: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  if (!Array.isArray(value)) return out;
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const clean = item.trim();
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
  }
  return out;
}

function unknownRecord(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

export function sanitizeTimelineSegmentDuration(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 3;
  return clamp(round1(n), TIMELINE_DIRECTOR_MIN_SEGMENT_DURATION_SEC, TIMELINE_DIRECTOR_MAX_SEGMENT_DURATION_SEC);
}

export function timelineDirectorTotalDuration(input: TimelineDirectorBlockInput[]): number {
  const blocks = sanitizeTimelineDirectorBlocks(input);
  return round1(blocks.reduce((sum, block) => sum + block.durationSec, 0));
}

function setSegmentDuration(
  blocks: TimelineDirectorBlock[],
  index: number,
  value: number,
) {
  blocks[index] = {
    ...blocks[index],
    durationSec: sanitizeTimelineSegmentDuration(value),
  };
}

export function normalizeTimelineDirectorTotalDuration(
  input: TimelineDirectorBlockInput[],
  preferredIndex = 0,
): TimelineDirectorBlock[] {
  const blocks = sanitizeTimelineDirectorBlocks(input);
  const segmentCount = blocks.length;
  if (segmentCount === 0) return blocks;

  const preferred = Math.max(0, Math.min(segmentCount - 1, Math.round(preferredIndex)));
  let total = timelineDirectorTotalDuration(blocks);

  if (total > TIMELINE_DIRECTOR_MAX_TOTAL_DURATION_SEC) {
    let overflow = round1(total - TIMELINE_DIRECTOR_MAX_TOTAL_DURATION_SEC);
    const order = [preferred, ...Array.from({ length: segmentCount }, (_, index) => index).filter((index) => index !== preferred).reverse()];
    for (const index of order) {
      if (overflow <= 0) break;
      const room = round1(blocks[index].durationSec - TIMELINE_DIRECTOR_MIN_SEGMENT_DURATION_SEC);
      if (room <= 0) continue;
      const cut = Math.min(room, overflow);
      setSegmentDuration(blocks, index, blocks[index].durationSec - cut);
      overflow = round1(overflow - cut);
    }
  }

  total = timelineDirectorTotalDuration(blocks);
  if (total < TIMELINE_DIRECTOR_MIN_TOTAL_DURATION_SEC) {
    let shortage = round1(TIMELINE_DIRECTOR_MIN_TOTAL_DURATION_SEC - total);
    const order = [preferred, ...Array.from({ length: segmentCount }, (_, index) => index).filter((index) => index !== preferred)];
    for (const index of order) {
      if (shortage <= 0) break;
      const room = round1(TIMELINE_DIRECTOR_MAX_SEGMENT_DURATION_SEC - blocks[index].durationSec);
      if (room <= 0) continue;
      const add = Math.min(room, shortage);
      setSegmentDuration(blocks, index, blocks[index].durationSec + add);
      shortage = round1(shortage - add);
    }
  }

  return blocks;
}

export function clampTimelineDirectorSegmentDuration(
  input: TimelineDirectorBlockInput[],
  index: number,
  value: unknown,
): number {
  const blocks = sanitizeTimelineDirectorBlocks(input);
  const segmentCount = blocks.length;
  if (index < 0 || index >= segmentCount) return sanitizeTimelineSegmentDuration(value);
  const next = blocks.map((block, blockIndex) => (
    blockIndex === index
      ? { ...block, durationSec: sanitizeTimelineSegmentDuration(value) }
      : block
  ));
  const normalized = normalizeTimelineDirectorTotalDuration(next, index);
  return normalized[index]?.durationSec ?? sanitizeTimelineSegmentDuration(value);
}

function basenameFromUrl(url: string): string {
  const clean = String(url || '').split(/[?#]/)[0];
  try {
    return decodeURIComponent(clean.split('/').pop() || '');
  } catch {
    return clean.split('/').pop() || '';
  }
}

function stripImageExt(value: string): string {
  return value.replace(/\.(png|jpe?g|webp|gif|bmp|avif|tiff?)$/i, '');
}

export function sanitizeTimelineImageName(input: unknown, fallbackUrl?: string, fallbackIndex = 0): string {
  const raw = cleanText(input, 80) || stripImageExt(basenameFromUrl(String(fallbackUrl || '')));
  const normalized = raw
    .replace(/^@+/, '')
    .replace(/[\\/:*?"<>|#?&=%]+/g, '_')
    .replace(/([A-Za-z0-9])\s+([A-Za-z0-9])/g, '$1_$2')
    .replace(/\s+/g, '')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  return normalized || `shot${fallbackIndex + 1}`;
}

export function timelineMentionToken(imageName: string): string {
  return `@${sanitizeTimelineImageName(imageName)}`;
}

export function sanitizeTimelineDirectorBlocks(input: TimelineDirectorBlockInput[]): TimelineDirectorBlock[] {
  const source = Array.isArray(input) ? input : [];
  return source.slice(0, 9).map((block, index) => {
    const imageUrl = cleanText(block.imageUrl, 20_000);
    const imageName = sanitizeTimelineImageName(block.imageName || block.title, imageUrl, index);
    const title = cleanText(block.title, 80) || imageName || `镜头${index + 1}`;
    return {
      id: cleanText(block.id, 96) || `timeline-shot-${index + 1}`,
      title,
      imageUrl,
      imageName,
      mentionToken: timelineMentionToken(imageName),
      prompt: cleanText(block.prompt, 4000),
      mentions: Array.isArray(block.mentions) ? block.mentions : [],
      durationSec: sanitizeTimelineSegmentDuration(block.durationSec),
    };
  });
}

export function buildTimelineDirectorSegments(
  input: TimelineDirectorBlockInput[],
): TimelineDirectorCompiledSegment[] {
  const blocks = sanitizeTimelineDirectorBlocks(input);
  const segments: TimelineDirectorCompiledSegment[] = [];

  for (let index = 0; index < blocks.length; index += 1) {
    const frame = blocks[index];
    const next = blocks[index + 1] || null;
    const description = frame.prompt || '按当前镜头图生成连续视频内容';
    const durationSec = sanitizeTimelineSegmentDuration(frame.durationSec);
    const parts = [
      next ? `${frame.mentionToken} -> ${next.mentionToken}` : frame.mentionToken,
      `时长：${durationSec}秒`,
      description,
    ];
    segments.push({
      index,
      fromToken: frame.mentionToken,
      toToken: next?.mentionToken || frame.mentionToken,
      durationSec,
      description,
      prompt: parts.join('\n'),
    });
  }

  return segments;
}

export function buildTimelineDirectorCompiledPrompt(
  input: TimelineDirectorBlockInput[],
  options: { globalPrompt?: string } = {},
): string {
  const blocks = sanitizeTimelineDirectorBlocks(input);
  const segments = buildTimelineDirectorSegments(blocks);
  return [
    cleanText(options.globalPrompt, 8000),
    ...segments.map((segment) => {
      return segment.prompt;
    }),
  ].filter(Boolean).join('\n\n');
}

export function buildTimelineDirectorExternalVideoRequest(
  input: TimelineDirectorBlockInput[],
  options: TimelineDirectorRequestOptions,
): GenerateExternalVideoRequest {
  const blocks = sanitizeTimelineDirectorBlocks(input);
  const timelineImages = blocks.map((block) => block.imageUrl).filter(Boolean);
  const referenceImages = cleanStringArray(options.referenceImages);
  const images = referenceImages.length ? [...referenceImages, ...timelineImages] : timelineImages;
  const videos = cleanStringArray(options.videos);
  const audios = cleanStringArray(options.audios);
  const segments = buildTimelineDirectorSegments(blocks);
  const fullPrompt = buildTimelineDirectorCompiledPrompt(blocks, {
    globalPrompt: options.globalPrompt,
  }) || '多镜头时间轴视频';
  const transitionCount = Math.max(0, timelineImages.length - 1);
  const transitionPrompts = segments.slice(0, transitionCount).map(() => fullPrompt);
  const transitionDurations = segments.slice(0, transitionCount).map((segment) => segment.durationSec);
  const duration = timelineDirectorTotalDuration(blocks);
  const providerParams = {
    ...(options.providerParams || {}),
    frameMode: referenceImages.length ? 'omni' : 'multiframe',
    generate_audio: options.generateAudio !== false,
    transitionPrompts,
    transitionDurations,
    timelineFrameImages: timelineImages,
    timelineReferenceImages: referenceImages,
    timelineFrames: blocks.map((block) => ({
      token: block.mentionToken,
      imageName: block.imageName,
      imageUrl: block.imageUrl,
    })),
    timelineReferenceVideos: videos,
    timelineReferenceAudios: audios,
  };

  return {
    providerId: options.providerId,
    providerModel: options.providerModel,
    model: options.model || options.providerModel,
    prompt: fullPrompt,
    aspect_ratio: options.aspectRatio,
    duration,
    resolution: options.resolution,
    seed: typeof options.seed === 'number' && options.seed >= 0 ? options.seed : undefined,
    images,
    videos,
    audios,
    providerParams,
  };
}

export function buildTimelineDirectorLlmOptimizationPrompt(
  input: TimelineDirectorBlockInput[],
  options: { mode?: TimelineDirectorLlmMode; globalPrompt?: string; globalStyle?: unknown } = {},
): { system: string; user: string } {
  const blocks = sanitizeTimelineDirectorBlocks(input);
  const segments = buildTimelineDirectorSegments(blocks);
  const mode = options.mode === 'full' ? 'full' : 'segment';
  const system = [
    '你是专业视频导演和提示词工程师。',
    '任务：优化时间分镜描述，用于即梦 Seedance 多镜头视频生成。',
    '必须保留所有 @图片名和时长，不要把 @图片名改成 URL。',
    '只优化描述词和镜头语言，让主体动作、环境变化、构图、光影、节奏更清楚。',
    mode === 'full' ? '输出格式：逐段输出，严格使用“第N段：优化后的描述词”。' : '输出格式：只输出优化后的描述词，不要加解释。',
  ].join('\n');
  const user = [
    `优化模式：${mode === 'full' ? '全文时间分镜脚本优化' : '单段时间分镜描述优化'}`,
    `总时长：${round1(segments.reduce((sum, segment) => sum + segment.durationSec, 0))}s`,
    cleanText(options.globalPrompt, 8000) ? `全局提示词：\n${cleanText(options.globalPrompt, 8000)}` : '',
    ...segments.map((segment) => [
      `第${segment.index + 1}段：${segment.fromToken} -> ${segment.toToken}`,
      `时长：${segment.durationSec}秒`,
      segment.description,
    ].join('\n')),
  ].filter(Boolean).join('\n');
  return { system, user };
}

export function parseTimelineDirectorFullLlmOutput(output: string): Map<number, string> {
  const map = new Map<number, string>();
  String(output || '').split(/\r?\n/).forEach((line) => {
    const match = line.match(/第\s*(\d+)\s*段\s*[:：]\s*(.+)$/);
    if (match) {
      const index = Number(match[1]);
      const text = cleanText(match[2], 4000);
      if (Number.isInteger(index) && index > 0 && text) map.set(index, text);
    }
  });
  return map;
}

function stripJsonFence(value: string): string {
  return String(value || '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

export function extractTimelineDirectorAgentPlanJson(output: string): any {
  const text = stripJsonFence(output);
  if (!text) throw new Error('Codex Agent 没有返回拆镜 JSON');
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        // Fall through to clear error below.
      }
    }
    throw new Error('Codex Agent 返回不是有效 JSON，无法安全写回时间轴');
  }
}

export function normalizeTimelineDirectorAgentPlan(
  value: unknown,
  options: { fallbackGlobalPrompt?: string; maxShots?: number } = {},
): TimelineDirectorAgentPlan {
  const raw = unknownRecord(value);
  const maxShots = clamp(Math.floor(Number(options.maxShots) || 9), 1, 9);
  const rawShots = Array.isArray(raw.shots)
    ? raw.shots
    : Array.isArray(raw.frames)
      ? raw.frames
      : Array.isArray(raw.blocks)
        ? raw.blocks
        : [];
  const shots = rawShots.slice(0, maxShots).map((item, index) => {
    const record = unknownRecord(item);
    const title = cleanText(record.title || record.name || record.shot || record.label, 80) || `镜头${index + 1}`;
    const imageName = sanitizeTimelineImageName(record.imageName || record.image_name || title, undefined, index);
    const prompt = cleanText(record.prompt || record.videoPrompt || record.video_prompt || record.description || record.desc, 4000);
    const imagePrompt = cleanText(record.imagePrompt || record.image_prompt || record.keyframePrompt || record.keyframe_prompt || prompt, 4000);
    return {
      title,
      imageName,
      prompt,
      imagePrompt,
      durationSec: sanitizeTimelineSegmentDuration(record.durationSec ?? record.duration ?? record.seconds ?? record.sec),
    };
  }).filter((shot) => shot.prompt || shot.imagePrompt);

  if (shots.length < 1) throw new Error('Codex Agent 至少需要返回 1 个镜头');

  const normalized = normalizeTimelineDirectorTotalDuration(shots.map((shot, index) => ({
    id: `agent-shot-${index + 1}`,
    title: shot.title,
    imageName: shot.imageName,
    prompt: shot.prompt || shot.imagePrompt,
    durationSec: shot.durationSec,
  })), 0);

  return {
    globalPrompt: cleanText(raw.globalPrompt || raw.global_prompt || raw.global || options.fallbackGlobalPrompt, 8000),
    shots: shots.map((shot, index) => ({
      ...shot,
      durationSec: normalized[index]?.durationSec ?? sanitizeTimelineSegmentDuration(shot.durationSec),
    })),
  };
}

export function buildTimelineDirectorAgentPlanPrompt(input: {
  script?: string;
  globalPrompt?: string;
  compiledPrompt?: string;
  blocks?: TimelineDirectorBlockInput[];
  referenceImageCount?: number;
  maxShots?: number;
}): { system: string; user: string } {
  const blocks = sanitizeTimelineDirectorBlocks(input.blocks || []);
  const maxShots = clamp(Math.floor(Number(input.maxShots) || 9), 1, 9);
  const system = [
    '你是时间轴导演台的 Codex Agent 执行规划器。',
    '任务：读取元脚本、全局提示词和参考图，拆成可直接生成关键帧图和单视频时间轴的镜头计划。',
    '必须只返回 JSON，不要 Markdown，不要解释。',
    'JSON 格式：{"globalPrompt":"全局提示词","shots":[{"title":"镜头1","imageName":"镜头1","durationSec":2,"prompt":"视频描述词","imagePrompt":"关键帧生图提示词"}]}',
    `镜头数量 1-${maxShots}；单镜头时长 1-12 秒；总时长 4-15 秒。`,
    '除非用户元脚本明确指定镜头数或单镜头时长，否则你自行决定镜头数和时长；默认优先拆成 4-6 个镜头，适配后续 2x2 或 2x3 宫格关键帧图。',
    'imageName 必须短、稳定、可作为 @图片名；prompt 是视频段描述；imagePrompt 是生成该镜头关键帧图的完整提示词。',
    '参考图已作为真实多模态图片输入给 Codex；如果用户用 @图片名定义角色/场景，必须继承其视觉身份。',
  ].join('\n');
  const user = [
    cleanText(input.script, 12000) ? `元脚本：\n${cleanText(input.script, 12000)}` : '',
    cleanText(input.globalPrompt, 8000) ? `全局提示词：\n${cleanText(input.globalPrompt, 8000)}` : '',
    cleanText(input.compiledPrompt, 12000) ? `当前时间轴：\n${cleanText(input.compiledPrompt, 12000)}` : '',
    blocks.length ? `当前镜头草稿：\n${blocks.map((block, index) => {
      return `镜头${index + 1}: ${block.mentionToken || timelineMentionToken(block.imageName || block.title || `镜头${index + 1}`)} / ${block.durationSec}s / ${block.prompt || '(空)'}`;
    }).join('\n')}` : '',
    `参考图数量：${Math.max(0, Math.floor(Number(input.referenceImageCount) || 0))}`,
    '请输出可执行 JSON。',
  ].filter(Boolean).join('\n\n');
  return { system, user };
}
