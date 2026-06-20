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

export const TIMELINE_DIRECTOR_MIN_SEGMENT_DURATION_SEC = 0.5;
export const TIMELINE_DIRECTOR_MAX_SEGMENT_DURATION_SEC = 8;
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
  return round1(blocks.slice(0, -1).reduce((sum, block) => sum + block.durationSec, 0));
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
  const segmentCount = Math.max(0, blocks.length - 1);
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
  const segmentCount = blocks.length - 1;
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
  return normalized || `frame${fallbackIndex + 1}`;
}

export function timelineMentionToken(imageName: string): string {
  return `@${sanitizeTimelineImageName(imageName)}`;
}

export function sanitizeTimelineDirectorBlocks(input: TimelineDirectorBlockInput[]): TimelineDirectorBlock[] {
  const source = Array.isArray(input) ? input : [];
  return source.slice(0, 9).map((block, index) => {
    const imageUrl = cleanText(block.imageUrl, 20_000);
    const imageName = sanitizeTimelineImageName(block.imageName || block.title, imageUrl, index);
    const title = cleanText(block.title, 80) || imageName || `帧${index + 1}`;
    return {
      id: cleanText(block.id, 96) || `timeline-frame-${index + 1}`,
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

  for (let index = 0; index < blocks.length - 1; index += 1) {
    const from = blocks[index];
    const to = blocks[index + 1];
    const description = from.prompt || '按两张关键帧图自然生成连续视频内容';
    const durationSec = sanitizeTimelineSegmentDuration(from.durationSec);
    const parts = [
      `${from.mentionToken} -> ${to.mentionToken}`,
      `时长：${durationSec}秒`,
      description,
    ];
    segments.push({
      index,
      fromToken: from.mentionToken,
      toToken: to.mentionToken,
      durationSec,
      description,
      prompt: parts.join('\n'),
    });
  }

  return segments;
}

function dreaminaFrameLabel(block: TimelineDirectorBlock, index: number): string {
  return `第${index + 1}帧（${block.imageName}）`;
}

function replaceTimelineImageTokensForDreamina(text: string, blocks: TimelineDirectorBlock[]): string {
  let next = cleanText(text, 8000);
  for (const [index, block] of blocks.entries()) {
    const token = block.mentionToken;
    if (!token) continue;
    next = next.replace(new RegExp(escapeRegExp(token), 'g'), dreaminaFrameLabel(block, index));
  }
  return next.trim();
}

export function buildTimelineDirectorCompiledPrompt(
  input: TimelineDirectorBlockInput[],
  options: { globalPrompt?: string } = {},
): string {
  const blocks = sanitizeTimelineDirectorBlocks(input);
  const segments = buildTimelineDirectorSegments(blocks);
  return [
    replaceTimelineImageTokensForDreamina(String(options.globalPrompt || ''), blocks),
    ...segments.map((segment) => {
      const from = blocks[segment.index];
      const to = blocks[segment.index + 1];
      return [
        `第${segment.index + 1}段：${dreaminaFrameLabel(from, segment.index)} -> ${dreaminaFrameLabel(to, segment.index + 1)}`,
        `时长：${segment.durationSec}秒`,
        replaceTimelineImageTokensForDreamina(segment.description, blocks),
      ].join('\n');
    }),
  ].filter(Boolean).join('\n\n');
}

export function buildTimelineDirectorExternalVideoRequest(
  input: TimelineDirectorBlockInput[],
  options: TimelineDirectorRequestOptions,
): GenerateExternalVideoRequest {
  const blocks = sanitizeTimelineDirectorBlocks(input);
  const images = blocks.map((block) => block.imageUrl).filter(Boolean);
  const videos = cleanStringArray(options.videos);
  const audios = cleanStringArray(options.audios);
  const segments = buildTimelineDirectorSegments(blocks);
  const fullPrompt = buildTimelineDirectorCompiledPrompt(blocks, {
    globalPrompt: options.globalPrompt,
  }) || '多关键帧时间轴视频';
  const transitionPrompts = segments.map(() => fullPrompt);
  const transitionDurations = segments.map((segment) => segment.durationSec);
  const duration = round1(transitionDurations.reduce((sum, value) => sum + value, 0));
  const providerParams = {
    ...(options.providerParams || {}),
    frameMode: 'multiframe',
    generate_audio: options.generateAudio !== false,
    transitionPrompts,
    transitionDurations,
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
    '任务：优化时间分镜描述，用于即梦 Seedance 多关键帧视频生成。',
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
