import { Fragment, memo, useEffect, useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { AlertCircle, ArrowLeft, ArrowRight, Clapperboard, Copy, Image as ImageIcon, Library, Loader2, Music, Plus, Sparkles, Trash2, Video as VideoIcon, Wand2, X } from 'lucide-react';
import {
  generateExternalVideo,
  generateLlm,
  generateExternalLlm,
  uploadFile,
} from '../../services/generation';
import { useUpdateNodeData } from './useUpdateNodeData';
import { useThemeStore } from '../../stores/theme';
import { logBus } from '../../stores/logs';
import { useUpstreamMaterials, type Material } from './useUpstreamMaterials';
import MentionPromptInput from './MentionPromptInput';
import LoopingVideo from '../LoopingVideo';
import SmartImage from '../SmartImage';
import { materialMentionKey, resolveMediaMentions, type MediaMention } from './mediaMentions';
import * as api from '../../services/api';
import { taskCompletionSound } from '../../stores/taskCompletionSound';
import { useApiKeysStore } from '../../stores/apiKeys';
import { DEFAULT_LLM_MODEL } from '../../providers/models';
import {
  advancedProviderModelOptions,
  advancedProvidersForNode,
  resolveAdvancedProviderSelection,
} from '../../utils/advancedProviders';
import {
  TIMELINE_DIRECTOR_MAX_SEGMENT_DURATION_SEC,
  TIMELINE_DIRECTOR_MAX_TOTAL_DURATION_SEC,
  TIMELINE_DIRECTOR_MIN_SEGMENT_DURATION_SEC,
  TIMELINE_DIRECTOR_MIN_TOTAL_DURATION_SEC,
  buildTimelineDirectorExternalVideoRequest,
  buildTimelineDirectorCompiledPrompt,
  buildTimelineDirectorLlmOptimizationPrompt,
  buildTimelineDirectorSegments,
  clampTimelineDirectorSegmentDuration,
  normalizeTimelineDirectorTotalDuration,
  parseTimelineDirectorFullLlmOutput,
  sanitizeTimelineDirectorBlocks,
  sanitizeTimelineImageName,
  timelineDirectorTotalDuration,
  type TimelineDirectorBlock,
  type TimelineDirectorBlockInput,
} from '../../utils/timelineDirector';

/**
 * TimelineDirectorNode — 单段视频 · 时间轴导演
 * 时间线由 N 个镜头组成,每个镜头 = 一张真实图片 + 该镜头之后的时长与描述。
 * 末镜头只定格、无时长。生成时按即梦能力把图片真实传入,完整 prompt 只发送一段。
 */

const MAX_IMAGES = 9;
const MIN_TOTAL = TIMELINE_DIRECTOR_MIN_TOTAL_DURATION_SEC;
const MAX_TOTAL = TIMELINE_DIRECTOR_MAX_TOTAL_DURATION_SEC;
const SEG_MIN = TIMELINE_DIRECTOR_MIN_SEGMENT_DURATION_SEC;
const SEG_MAX = TIMELINE_DIRECTOR_MAX_SEGMENT_DURATION_SEC;
const RATIO_OPTIONS = ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9', '9:21', 'adaptive'];
const RESOLUTION_OPTIONS = ['480p', '720p', 'native1080p', '1080p', '2k', '4k'];

type Block = TimelineDirectorBlock;
type ReferenceKind = 'image' | 'video' | 'audio';

const SEG_STEP = 0.1;
const genId = (p: string) => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const round1 = (v: number) => Math.round(v * 10) / 10;
const newBlock = (): Block => sanitizeTimelineDirectorBlocks([{
  id: genId('blk'),
  title: '',
  imageName: '',
  imageUrl: '',
  prompt: '',
  mentions: [],
  durationSec: 3,
}])[0];

// 拖拽→时长:像素位移换算到秒(0.1s 精度,钳 SEG_MIN..SEG_MAX)。与导演台整秒版分开,因本节点要亚秒。
const calcDragDuration = (startDur: number, startX: number, curX: number, widthPx: number, totalSec: number): number => {
  const total = Math.max(SEG_MIN, Number.isFinite(totalSec) ? totalSec : SEG_MIN);
  const pxPerSec = Math.max(4, Math.max(1, widthPx) / total);
  const delta = Math.round(((curX - startX) / pxPerSec) / SEG_STEP) * SEG_STEP;
  return clamp(round1(startDur + delta), SEG_MIN, SEG_MAX);
};

function fileName(url: string): string {
  try {
    return decodeURIComponent((url.split('?')[0].split('/').pop() || url).slice(0, 42));
  } catch {
    return (url.split('?')[0].split('/').pop() || url).slice(0, 42);
  }
}

function dedupe(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const clean = String(value || '').trim();
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
  }
  return out;
}

function collectMentionedMedia(mentions: MediaMention[], materials: Material[]) {
  const byKey = new Map<string, Material>();
  for (const material of materials) byKey.set(materialMentionKey(material), material);
  const images: string[] = [];
  const videos: string[] = [];
  const audios: string[] = [];
  for (const mention of Array.isArray(mentions) ? mentions : []) {
    const material = byKey.get(mention.materialKey);
    if (!material) continue;
    if (material.kind === 'image') images.push(material.url);
    if (material.kind === 'video') videos.push(material.url);
    if (material.kind === 'audio') audios.push(material.url);
  }
  return { images: dedupe(images), videos: dedupe(videos), audios: dedupe(audios) };
}

const TimelineDirectorNode = ({ id, data, selected }: NodeProps) => {
  const update = useUpdateNodeData(id);
  const [error, setError] = useState<string | null>(null);
  const [optimizing, setOptimizing] = useState(false);
  const [resourcePickerKind, setResourcePickerKind] = useState<ReferenceKind | null>(null);
  const [resourceItems, setResourceItems] = useState<api.ResourceItem[]>([]);
  const [resourceQuery, setResourceQuery] = useState('');
  const [resourceLoading, setResourceLoading] = useState(false);
  const [resourceMessage, setResourceMessage] = useState('');
  const [activeId, setActiveId] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const elapsedTimer = useRef<number | null>(null);
  const uploadImageRef = useRef<HTMLInputElement | null>(null);
  const uploadVideoRef = useRef<HTMLInputElement | null>(null);
  const uploadAudioRef = useRef<HTMLInputElement | null>(null);
  const src = `timeline-director:${id.slice(0, 6)}`;

  const { theme, style: themeStyle } = useThemeStore();
  const isDark = theme === 'dark';
  const isPixel = themeStyle === 'pixel';
  const advancedProviders = useApiKeysStore((s) => s.settings.advancedProviders);

  const d = (data as any) || {};
  const blocks: Block[] = useMemo(
    () => sanitizeTimelineDirectorBlocks(Array.isArray(d.blocks) && d.blocks.length ? d.blocks : []),
    [d.blocks],
  );
  const generateAudio: boolean = d.generateAudio !== false;
  const llmMode: 'segment' | 'full' = d.llmMode === 'full' ? 'full' : 'segment';
  const ratio: string = d.ratio || '16:9';
  const resolution: string = d.resolution || '720p';
  const llmProviderSelection = useMemo(
    () => resolveAdvancedProviderSelection(advancedProviders, 'llm', {
      providerSource: d?.llmProviderSource,
      providerId: d?.llmProviderId,
      providerModel: d?.llmProviderModel,
    }),
    [advancedProviders, d?.llmProviderSource, d?.llmProviderId, d?.llmProviderModel],
  );
  const llmProviders = useMemo(() => advancedProvidersForNode(advancedProviders, 'llm'), [advancedProviders]);
  const llmModelOptions = llmProviderSelection.provider ? advancedProviderModelOptions(llmProviderSelection.provider, 'llm') : [];
  const llmProviderModel = llmProviderSelection.providerModel || llmModelOptions[0] || '';
  const status: 'idle' | 'running' | 'success' | 'error' = d.status || 'idle';
  const videoUrl: string | undefined = d.videoUrl;

  // 初始种子:默认 2 块,让时间线立即可见
  useEffect(() => {
    if (!Array.isArray(d.blocks) || d.blocks.length === 0) {
      update({ blocks: [newBlock(), newBlock()] });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // === Provider: 仅即梦 CLI ===
  const videoProviders = useMemo(() => advancedProvidersForNode(advancedProviders, 'video'), [advancedProviders]);
  const jimengProviders = useMemo(() => videoProviders.filter((p: any) => p?.protocol === 'jimeng-cli'), [videoProviders]);
  const selection = useMemo(
    () => resolveAdvancedProviderSelection(advancedProviders, 'video', {
      providerSource: d?.providerSource, providerId: d?.providerId, providerModel: d?.providerModel,
    }),
    [advancedProviders, d?.providerSource, d?.providerId, d?.providerModel],
  );
  const activeJimeng = jimengProviders.find((p: any) => p.id === d?.providerId) || jimengProviders[0] || null;
  const externalModelOptions = activeJimeng ? advancedProviderModelOptions(activeJimeng, 'video') : [];
  const providerModel = d?.providerModel || selection.providerModel || externalModelOptions[0] || 'seedance2.0fast_vip';

  const upstream = useUpstreamMaterials(id);
  const localRefVideos = useMemo(() => dedupe(Array.isArray(d.localRefVideos) ? d.localRefVideos : []), [d.localRefVideos]);
  const localRefAudios = useMemo(() => dedupe(Array.isArray(d.localRefAudios) ? d.localRefAudios : []), [d.localRefAudios]);
  const localMaterials = useMemo<Material[]>(
    () => [
      ...blocks.filter((block) => block.imageUrl).map((block, index) => ({
        id: `${id}:timeline-frame-image:${block.id}:${block.imageUrl}`,
        kind: 'image' as const,
        url: block.imageUrl,
        sourceNodeId: id,
        origin: 'local' as const,
        label: block.imageName || `镜头${index + 1}`,
        mentionKey: `timeline-frame:${block.id}:${block.imageUrl}`,
        mentionToken: block.mentionToken,
      })),
      ...localRefVideos.map((url, index) => ({
        id: `${id}:timeline-local-video:${index}:${url}`,
        kind: 'video' as const,
        url,
        sourceNodeId: id,
        origin: 'local' as const,
        label: `全局视频${index + 1}`,
      })),
      ...localRefAudios.map((url, index) => ({
        id: `${id}:timeline-local-audio:${index}:${url}`,
        kind: 'audio' as const,
        url,
        sourceNodeId: id,
        origin: 'local' as const,
        label: `全局音频${index + 1}`,
      })),
    ],
    [blocks, id, localRefVideos, localRefAudios],
  );
  const mentionMaterials = useMemo(
    () => [...upstream.texts, ...upstream.images, ...upstream.videos, ...upstream.audios, ...localMaterials],
    [upstream.texts, upstream.images, upstream.videos, upstream.audios, localMaterials],
  );
  const globalPrompt: string = typeof d.globalPrompt === 'string' ? d.globalPrompt : '';
  const globalPromptMentions: MediaMention[] = Array.isArray(d.globalPromptMentions) ? d.globalPromptMentions : [];

  // 末镜头不计时长;总时长 = 前 N-1 个镜头时长和
  const totalDuration = useMemo(
    () => round1(blocks.slice(0, -1).reduce((s, b) => s + (Number(b.durationSec) || 0), 0)),
    [blocks],
  );
  const imagedCount = blocks.filter((b) => b.imageUrl).length;
  const canAddBlock = blocks.length < MAX_IMAGES && totalDuration < MAX_TOTAL;
  const activeIndex = blocks.findIndex((b) => b.id === activeId);
  const activeBlock = activeIndex >= 0 ? blocks[activeIndex] : null;
  const isLastActive = activeIndex === blocks.length - 1;

  useEffect(() => {
    if (blocks.length > 0 && !blocks.some((block) => block.id === activeId)) {
      setActiveId(blocks[0].id);
    }
  }, [activeId, blocks]);

  const setBlocks = (next: TimelineDirectorBlockInput[], preferredIndex = 0) => update({ blocks: normalizeTimelineDirectorTotalDuration(next, preferredIndex) });
  const patchBlock = (bid: string, patch: Partial<Block>) => {
    const preferredIndex = Math.max(0, blocks.findIndex((block) => block.id === bid));
    setBlocks(blocks.map((b) => (b.id === bid ? { ...b, ...patch } : b)), preferredIndex);
  };
  const addBlock = () => {
    if (!canAddBlock) return;
    const b = newBlock();
    setBlocks([...blocks, b], blocks.length - 1);
    setActiveId(b.id);
  };
  const removeBlock = (bid: string) => {
    if (blocks.length <= 2) { setError('至少保留 2 个镜头'); return; }
    const next = blocks.filter((b) => b.id !== bid);
    setBlocks(next);
    if (activeId === bid) setActiveId(null);
  };
  const duplicateBlock = (bid: string) => {
    if (!canAddBlock) return;
    const i = blocks.findIndex((b) => b.id === bid);
    if (i < 0) return;
    const copy = { ...blocks[i], id: genId('blk'), title: '', imageName: `${blocks[i].imageName || `镜头${i + 1}`}_copy` };
    setBlocks([...blocks.slice(0, i + 1), copy, ...blocks.slice(i + 1)], i + 1);
    setActiveId(copy.id);
  };
  const moveBlock = (bid: string, dir: -1 | 1) => {
    const i = blocks.findIndex((b) => b.id === bid);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= blocks.length) return;
    const next = [...blocks];
    [next[i], next[j]] = [next[j], next[i]];
    setBlocks(next, Math.min(i, j));
  };
  const stopDeleteFromCanvas = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.stopPropagation();
    }
  };
  const setActiveImage = (url: string, name?: string) => {
    if (!activeBlock) return;
    const patch: Partial<Block> = { imageUrl: url };
    if (!activeBlock.imageName || /^(frame|shot)\d+$/i.test(activeBlock.imageName) || /^镜头\d+$/i.test(activeBlock.imageName)) {
      patch.imageName = sanitizeTimelineImageName(name || activeBlock.title, url, activeIndex);
    }
    patchBlock(activeBlock.id, patch);
  };
  const appendRefs = (kind: 'video' | 'audio', urls: string[]) => {
    const clean = dedupe(urls);
    if (!clean.length) return;
    if (kind === 'video') {
      update({ localRefVideos: dedupe([...localRefVideos, ...clean]) });
      return;
    }
    update({ localRefAudios: dedupe([...localRefAudios, ...clean]) });
  };
  const handleUpload = async (kind: ReferenceKind, event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || []);
    event.target.value = '';
    if (!files.length) return;
    try {
      logBus.info(`时间轴导演上传${kind === 'image' ? '图片' : kind === 'video' ? '视频' : '音频'} ${files.length} 个`, src);
      const uploaded = await Promise.all(files.map((file) => uploadFile(file)));
      const urls = uploaded.map((item) => item.url).filter(Boolean);
      if (kind === 'image') {
        const first = uploaded[0];
        if (first) setActiveImage(first.url, first.filename || files[0]?.name);
        return;
      }
      appendRefs(kind, urls);
    } catch (uploadError: any) {
      const message = uploadError?.message || '上传失败';
      setError(message);
      logBus.error(`时间轴导演素材上传失败: ${message}`, src);
    }
  };
  const openResourcePicker = (kind: ReferenceKind) => {
    setResourcePickerKind(kind);
    setResourceQuery('');
    setResourceItems([]);
    setResourceMessage('');
  };
  const closeResourcePicker = () => {
    setResourcePickerKind(null);
    setResourceQuery('');
    setResourceItems([]);
    setResourceMessage('');
  };
  const handlePickResourceItem = async (item: api.ResourceItem) => {
    if (!resourcePickerKind || !item.fileUrl) return;
    if (resourcePickerKind === 'image') {
      setActiveImage(item.fileUrl, item.title || item.originalName || item.id);
    } else {
      appendRefs(resourcePickerKind, [item.fileUrl]);
    }
    void api.updateResourceItem(item.id, { touch: true });
    closeResourcePicker();
  };

  // === 拖拽调时长 — 1:1 复刻 DirectorStoryboardNode 的 duration-resize / bridge-separator 机制 ===
  type ResizeState = { blockId: string; baseBlocks: Block[]; startClientX: number; startDurationSec: number; timelineWidthPx: number; totalDurationSec: number };
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const resizeActiveRef = useRef(false);
  const resizeStateRef = useRef<ResizeState | null>(null);
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  const separatorActiveRef = useRef(false);

  const applyResize = (clientX: number) => {
    const state = resizeStateRef.current;
    if (!state) return false;
    const index = state.baseBlocks.findIndex((block) => block.id === state.blockId);
    const rawDurationSec = calcDragDuration(state.startDurationSec, state.startClientX, clientX, state.timelineWidthPx, state.totalDurationSec);
    const durationSec = clampTimelineDirectorSegmentDuration(state.baseBlocks, index, rawDurationSec);
    update({ blocks: normalizeTimelineDirectorTotalDuration(state.baseBlocks.map((b) => (b.id === state.blockId ? { ...b, durationSec } : b)), index) });
    return true;
  };
  const finishResize = () => {
    resizeActiveRef.current = false;
    resizeStateRef.current = null;
    const cleanup = resizeCleanupRef.current;
    resizeCleanupRef.current = null;
    cleanup?.();
  };
  const startResizeSession = (block: Block, startClientX: number, cleanup: () => void): boolean => {
    const rect = timelineRef.current?.getBoundingClientRect();
    if (!rect || resizeActiveRef.current) return false;
    resizeCleanupRef.current?.();
    resizeActiveRef.current = true;
    resizeStateRef.current = {
      blockId: block.id,
      baseBlocks: blocks,
      startClientX,
      startDurationSec: Number(block.durationSec) || 0,
      timelineWidthPx: rect.width,
      totalDurationSec: Math.max(SEG_MIN, timelineDirectorTotalDuration(blocks)),
    };
    resizeCleanupRef.current = cleanup;
    return true;
  };
  // 块右缘手柄:按下即拖(= beginDurationResize)
  const beginResize = (event: React.PointerEvent<HTMLButtonElement> | React.MouseEvent<HTMLButtonElement>, block: Block) => {
    if ('button' in event && event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const onMove = (nativeEvent: globalThis.PointerEvent | globalThis.MouseEvent) => {
      nativeEvent.preventDefault();
      nativeEvent.stopPropagation();
      applyResize(nativeEvent.clientX);
    };
    const cleanup = () => {
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerup', cleanup, true);
      window.removeEventListener('pointercancel', cleanup, true);
      window.removeEventListener('mousemove', onMove, true);
      window.removeEventListener('mouseup', cleanup, true);
      resizeCleanupRef.current = null;
      resizeActiveRef.current = false;
      resizeStateRef.current = null;
    };
    if (!startResizeSession(block, event.clientX, cleanup)) return;
    if ('pointerId' in event) {
      try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* 全局监听兜底 */ }
    }
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', cleanup, true);
    window.addEventListener('pointercancel', cleanup, true);
    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('mouseup', cleanup, true);
  };
  const moveResize = (event: React.PointerEvent<HTMLButtonElement> | React.MouseEvent<HTMLButtonElement>) => {
    if (!resizeStateRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    applyResize(event.clientX);
  };
  const endResize = (event: React.PointerEvent<HTMLButtonElement> | React.MouseEvent<HTMLButtonElement>) => {
    if (!resizeStateRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    if ('pointerId' in event) {
      try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* ignore */ }
    }
    finishResize();
  };
  // ↔ 分隔:移动<4px=点击选中该镜头,否则拖拽调时长(= beginBridgeSeparatorInteraction)
  const beginSeparator = (event: React.PointerEvent<HTMLButtonElement> | React.MouseEvent<HTMLButtonElement>, block: Block) => {
    if ('button' in event && event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    if (separatorActiveRef.current) return;
    separatorActiveRef.current = true;
    const startClientX = event.clientX;
    const startClientY = event.clientY;
    let didResize = false;
    function cleanup() {
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerup', onUp, true);
      window.removeEventListener('pointercancel', onCancel, true);
      window.removeEventListener('mousemove', onMove, true);
      window.removeEventListener('mouseup', onUp, true);
      separatorActiveRef.current = false;
    }
    function onMove(nativeEvent: globalThis.PointerEvent | globalThis.MouseEvent) {
      const moved = Math.abs(nativeEvent.clientX - startClientX) + Math.abs(nativeEvent.clientY - startClientY);
      if (!didResize && moved < 4) return;
      nativeEvent.preventDefault();
      nativeEvent.stopPropagation();
      if (!didResize) {
        didResize = startResizeSession(block, startClientX, cleanup);
        if (!didResize) return;
      }
      applyResize(nativeEvent.clientX);
    }
    function onUp(nativeEvent: globalThis.PointerEvent | globalThis.MouseEvent) {
      nativeEvent.preventDefault();
      nativeEvent.stopPropagation();
      if (didResize) { finishResize(); return; }
      cleanup();
      setActiveId(block.id);
    }
    function onCancel() {
      if (didResize) { finishResize(); return; }
      cleanup();
    }
    if ('pointerId' in event) {
      try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* 全局监听兜底 */ }
    }
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('pointercancel', onCancel, true);
    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('mouseup', onUp, true);
  };

  // 资源库拉取
  useEffect(() => {
    if (!resourcePickerKind) return;
    let cancelled = false;
    setResourceLoading(true);
    setResourceMessage('');
    const timer = window.setTimeout(() => {
      void (async () => {
        const res = await api.getResourceItems({ kind: resourcePickerKind, q: resourceQuery.trim() });
        if (cancelled) return;
        if (res.success) {
          setResourceItems((res.data || []).filter((it) => !!it.fileUrl));
          setResourceMessage('');
        } else {
          setResourceItems([]);
          setResourceMessage(res.error || '资源库读取失败');
        }
        setResourceLoading(false);
      })();
    }, 120);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [resourcePickerKind, resourceQuery]);

  // === LLM 优化 ===
  const callLlm = async (system: string, user: string): Promise<string> => {
    const useExternal = llmProviderSelection.available && llmProviderSelection.providerSource !== 'zhenzhen' && llmProviderSelection.providerId;
    const messages = [{ role: 'system' as const, content: system }, { role: 'user' as const, content: user }];
    if (useExternal) {
      const r = await generateExternalLlm({
        providerId: llmProviderSelection.providerId,
        providerModel: llmProviderModel,
        model: llmProviderModel || DEFAULT_LLM_MODEL,
        messages,
        providerParams: d?.llmProviderParams || {},
      });
      return r.content || '';
    }
    const r = await generateLlm({ model: d.llmModel || DEFAULT_LLM_MODEL, messages });
    return r.content || '';
  };
  const handleOptimize = async () => {
    const transBlocks = blocks.slice(0, -1);
    if (!transBlocks.length) { setError('先添加镜头'); return; }
    const resolvedGlobalPrompt = resolveMediaMentions(globalPrompt, globalPromptMentions, mentionMaterials).trim();
    setError(null); setOptimizing(true);
    try {
      if (llmMode === 'full') {
        const prompt = buildTimelineDirectorLlmOptimizationPrompt(blocks, { mode: 'full', globalPrompt: resolvedGlobalPrompt });
        const out = await callLlm(prompt.system, prompt.user);
        const map = parseTimelineDirectorFullLlmOutput(out);
        setBlocks(blocks.map((b, i) => (i < transBlocks.length && map.has(i + 1) ? { ...b, prompt: map.get(i + 1) as string, mentions: [] } : b)));
      } else {
        const next = [...blocks];
        for (let i = 0; i < next.length - 1; i += 1) {
          const resolved = resolveMediaMentions(next[i].prompt, next[i].mentions, mentionMaterials).trim();
          if (!resolved) continue;
          const prompt = buildTimelineDirectorLlmOptimizationPrompt(
            blocks.map((b, idx) => (idx === i ? { ...b, prompt: resolved } : b)),
            { mode: 'segment', globalPrompt: resolvedGlobalPrompt },
          );
          const segmentLine = prompt.user.split('\n').find((line) => line.startsWith(`第${i + 1}段`)) || prompt.user;
          const out = await callLlm(prompt.system, segmentLine);
          next[i] = { ...next[i], prompt: out.trim(), mentions: [] };
        }
        setBlocks(next);
      }
      logBus.success('LLM 分镜优化完成', src);
    } catch (e: any) {
      setError(e?.message || 'LLM 优化失败');
    } finally { setOptimizing(false); }
  };

  // === 编译即梦参数 ===
  const resolvedGlobalPrompt = useMemo(
    () => resolveMediaMentions(globalPrompt, globalPromptMentions, mentionMaterials).trim(),
    [globalPrompt, globalPromptMentions, mentionMaterials],
  );
  const resolvedBlocks = useMemo(() => blocks.map((block) => ({
    ...block,
    prompt: resolveMediaMentions(block.prompt, block.mentions, mentionMaterials).trim(),
    mentions: [] as MediaMention[],
  })), [blocks, mentionMaterials]);
  const mentionedMedia = useMemo(() => {
    const allMentions = [
      ...globalPromptMentions,
      ...blocks.flatMap((block) => (Array.isArray(block.mentions) ? block.mentions : [])),
    ];
    return collectMentionedMedia(allMentions, mentionMaterials);
  }, [blocks, globalPromptMentions, mentionMaterials]);
  const requestVideos = useMemo(
    () => dedupe([...localRefVideos, ...mentionedMedia.videos]),
    [localRefVideos, mentionedMedia.videos],
  );
  const requestAudios = useMemo(
    () => dedupe([...localRefAudios, ...mentionedMedia.audios]),
    [localRefAudios, mentionedMedia.audios],
  );
  const timelineImageUrls = useMemo(() => dedupe(blocks.map((block) => block.imageUrl)), [blocks]);
  const requestImages = useMemo(() => {
    const timelineSet = new Set(timelineImageUrls);
    return dedupe(mentionedMedia.images.filter((url) => !timelineSet.has(url)));
  }, [mentionedMedia.images, timelineImageUrls]);
  const totalRequestImages = useMemo(() => dedupe([...requestImages, ...timelineImageUrls]).length, [requestImages, timelineImageUrls]);
  const totalValid = blocks.length >= 2 && imagedCount === blocks.length && totalDuration >= MIN_TOTAL && totalDuration <= MAX_TOTAL && totalRequestImages <= MAX_IMAGES;
  const compiledSegments = useMemo(() => buildTimelineDirectorSegments(resolvedBlocks), [resolvedBlocks]);
  const compiledPrompt = useMemo(
    () => buildTimelineDirectorCompiledPrompt(resolvedBlocks, { globalPrompt: resolvedGlobalPrompt }),
    [resolvedBlocks, resolvedGlobalPrompt],
  );
  const compiled = useMemo(() => ({
    prompt: compiledPrompt,
    transitionPrompts: compiledSegments.map(() => compiledPrompt),
    transitionDurations: compiledSegments.map((segment) => segment.durationSec),
    images: dedupe([...requestImages, ...timelineImageUrls]),
    referenceImages: requestImages,
    videos: requestVideos,
    audios: requestAudios,
  }), [compiledPrompt, compiledSegments, requestImages, requestVideos, requestAudios, timelineImageUrls]);

  // === 生成 ===
  const startTimer = () => { setElapsed(0); if (elapsedTimer.current) window.clearInterval(elapsedTimer.current); elapsedTimer.current = window.setInterval(() => setElapsed((e) => e + 1), 1000) as unknown as number; };
  const stopTimer = () => { if (elapsedTimer.current) { window.clearInterval(elapsedTimer.current); elapsedTimer.current = null; } };
  useEffect(() => () => stopTimer(), []);

  const handleGenerate = async () => {
    setError(null);
    if (!activeJimeng) { setError('未配置即梦 CLI 平台(API 设置 → 高级供应商)'); return; }
    if (blocks.length < 2) { setError('至少需要 2 个镜头'); return; }
    if (imagedCount !== blocks.length) { setError('每个镜头都要设置图片'); return; }
    if (totalDuration < MIN_TOTAL || totalDuration > MAX_TOTAL) { setError(`总时长需在 ${MIN_TOTAL}-${MAX_TOTAL}s(当前 ${totalDuration}s)`); return; }
    if (totalRequestImages > MAX_IMAGES) { setError(`即梦最多接收 ${MAX_IMAGES} 张图片：全局 @ 图片 + 镜头图片当前 ${totalRequestImages} 张`); return; }
    taskCompletionSound.primeAudio();
    update({ status: 'running', error: null, videoUrl: null });
    startTimer();
    try {
      logBus.info(`即梦时间轴: ${blocks.length}镜头 / ${totalDuration}s · ${providerModel}`, src);
      const request = buildTimelineDirectorExternalVideoRequest(resolvedBlocks, {
        providerId: activeJimeng.id,
        providerModel,
        model: providerModel,
        aspectRatio: ratio,
        resolution,
        generateAudio,
        seed: -1,
        globalPrompt: resolvedGlobalPrompt,
        referenceImages: requestImages,
        videos: requestVideos,
        audios: requestAudios,
        providerParams: d?.providerParams && typeof d.providerParams === 'object' ? d.providerParams : {},
      });
      const r = await generateExternalVideo(request);
      const nextUrl = r.videoUrls[0];
      if (!nextUrl) throw new Error('即梦没有返回视频');
      update({ status: 'success', videoUrl: nextUrl, videoUrls: r.videoUrls, remoteVideoUrls: r.remoteVideoUrls, taskId: r.taskId || null });
      logBus.success(`时间轴导演完成 → ${nextUrl}`, src);
      taskCompletionSound.notifyComplete(id, 'seedance');
    } catch (e: any) {
      update({ status: 'error' });
      setError(e?.message || '生成失败');
    } finally { stopTimer(); }
  };

  const running = status === 'running';
  const mmss = `${String(Math.floor(elapsed / 60)).padStart(2, '0')}:${String(elapsed % 60).padStart(2, '0')}`;
  const border = 'var(--t8-border-strong, rgba(255,255,255,.18))';
  const subBorder = 'var(--t8-border, rgba(255,255,255,.12))';
  const inputStyle = {
    background: 'var(--t8-bg-panel, rgba(15,23,42,.72))',
    color: 'var(--t8-text-main, #f8fafc)',
    borderColor: border,
  };
  const mutedStyle = {
    color: 'var(--t8-text-muted, rgba(248,250,252,.62))',
  };
  const cardStyle = {
    borderColor: subBorder,
    background: 'var(--t8-bg-panel, rgba(15,23,42,.52))',
  };
  const statusText = running ? '生成中' : status === 'success' ? '已完成' : status === 'error' ? '有失败' : '待生成';
  const completedVideoUrls = (Array.isArray(d.videoUrls) ? d.videoUrls : []).filter(Boolean);
  const currentOutputCount = videoUrl || completedVideoUrls.length ? 1 : 0;
  const latestVideoUrl = videoUrl || completedVideoUrls[0] || '';
  const refreshOutputs = () => {
    const urls = completedVideoUrls.length ? completedVideoUrls : (videoUrl ? [videoUrl] : []);
    if (urls.length) update({ videoUrl: urls[0], videoUrls: urls });
  };
  const cardCls = `rounded-md border p-3 ${isPixel ? 'px-card' : ''}`;
  const btnCls = 'nodrag flex h-9 items-center justify-center gap-1 rounded border px-2 py-1 text-[11px] leading-none';
  const controlCls = 'nodrag h-9 rounded border px-2 py-1 text-[11px] leading-normal outline-none';
  const resourceKindLabel = resourcePickerKind === 'image' ? '图像' : resourcePickerKind === 'video' ? '视频' : '音频';
  const renderResourcePreview = (item: api.ResourceItem) => {
    if (resourcePickerKind === 'video') {
      return <LoopingVideo src={item.fileUrl} className="h-full w-full object-cover" muted />;
    }
    if (resourcePickerKind === 'audio') {
      return (
        <div className="flex h-full w-full flex-col items-center justify-center gap-1 bg-black/35 text-[9px]">
          <Music size={17} />
          <span className="max-w-full truncate px-1">{fileName(item.fileUrl)}</span>
        </div>
      );
    }
    return <SmartImage src={item.thumbUrl || item.fileUrl} alt={item.title} thumbSize={160} className="h-full w-full object-cover" />;
  };
  const resourcePicker = resourcePickerKind ? (
    <div
      className="nodrag nopan absolute left-3 right-3 top-[112px] z-50 rounded-lg border p-2 shadow-2xl"
      style={{
        background: 'var(--t8-bg-node, rgba(10,15,24,.98))',
        borderColor: border,
        color: 'var(--t8-text-main, #f8fafc)',
      }}
      onPointerDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <div className="mb-2 flex items-center gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-1.5 text-xs font-semibold">
          <Library size={14} />
          <span className="truncate">从资源库导入{resourceKindLabel}</span>
        </div>
        <button type="button" className="nodrag flex h-7 w-7 items-center justify-center rounded border" style={{ borderColor: border }} onClick={closeResourcePicker} title="关闭">
          <X size={13} />
        </button>
      </div>
      <input
        className={`${controlCls} mb-2 w-full`}
        style={inputStyle}
        placeholder={`搜索资源库${resourceKindLabel}`}
        value={resourceQuery}
        onChange={(event) => setResourceQuery(event.target.value)}
      />
      {resourceMessage && (
        <div className="mb-2 rounded border px-2 py-1 text-[10px]" style={{ borderColor: subBorder, ...mutedStyle }}>
          {resourceMessage}
        </div>
      )}
      <div className="max-h-56 overflow-y-auto pr-1">
        {resourceLoading ? (
          <div className="flex h-24 items-center justify-center gap-1.5 text-[11px]" style={mutedStyle}>
            <Loader2 size={13} className="animate-spin" /> 读取资源库...
          </div>
        ) : resourceItems.length === 0 ? (
          <div className="flex h-24 items-center justify-center text-[11px]" style={mutedStyle}>暂无{resourceKindLabel}资源</div>
        ) : (
          <div className="grid grid-cols-3 gap-1.5">
            {resourceItems.slice(0, 60).map((item) => (
              <button
                type="button"
                key={item.id}
                className="nodrag min-w-0 overflow-hidden rounded border p-1 text-left"
                style={{ borderColor: subBorder, background: 'var(--t8-bg-panel, rgba(15,23,42,.58))' }}
                onClick={() => void handlePickResourceItem(item)}
                title={item.title}
              >
                <div className="mb-1 h-16 overflow-hidden rounded bg-black/40">
                  {renderResourcePreview(item)}
                </div>
                <div className="truncate text-[10px] font-semibold">{item.title || fileName(item.fileUrl)}</div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  ) : null;

  return (
    <div
      className={`relative w-[460px] overflow-visible rounded-lg border-2 text-sm shadow-2xl transition-all ${selected ? 'shadow-fuchsia-500/20' : ''}`}
      style={{
        background: 'var(--t8-bg-node, rgba(10,15,24,.95))',
        color: 'var(--t8-text-main, #f8fafc)',
        borderColor: selected ? 'var(--t8-accent, #d946ef)' : border,
      }}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="director-storyboard-port !h-4 !w-4 !border-2"
        style={{ left: -9, background: 'var(--t8-accent, #d946ef)', borderColor: 'var(--t8-bg-node, rgba(10,15,24,.95))', zIndex: 30 }}
      />
      <Handle
        type="source"
        position={Position.Right}
        className="director-storyboard-port !h-4 !w-4 !border-2"
        style={{ right: -9, background: 'var(--t8-accent, #d946ef)', borderColor: 'var(--t8-bg-node, rgba(10,15,24,.95))', zIndex: 30 }}
      />

      {resourcePicker}

      {/* 头部 */}
      <div className="flex items-center gap-2 border-b px-3 py-2" style={{ borderColor: subBorder }}>
        <div
          className="flex h-8 w-8 items-center justify-center rounded-md border"
          style={{
            background: 'color-mix(in srgb, var(--t8-accent, #d946ef) 18%, transparent)',
            borderColor: 'var(--t8-accent, #d946ef)',
            color: 'var(--t8-accent, #d946ef)',
          }}
        >
          <Clapperboard size={17} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="font-semibold leading-tight">时间轴导演台</div>
          <div className="truncate text-[11px]" style={mutedStyle}>
            {blocks.length} 镜头 · {totalDuration}s · Seedance2.0 单视频
          </div>
        </div>
        <span
          className="rounded border px-2 py-1 text-[10px] font-semibold"
          style={{ borderColor: border, color: 'var(--t8-accent, #d946ef)' }}
        >
          {running ? `${statusText} ${mmss}` : statusText}
        </span>
      </div>

      <div className="space-y-2 p-3 nodrag">
        <div className="space-y-2 rounded border border-white/10 bg-white/[0.03] p-2">
          <button
            type="button"
            onClick={() => update({ advancedProviderOpen: !d?.advancedProviderOpen })}
            className="nodrag flex w-full items-center justify-between rounded px-1 py-1 text-[10px] font-semibold hover:bg-white/5"
            style={mutedStyle}
          >
            <span>高级来源</span>
            <span>{activeJimeng ? activeJimeng.label || activeJimeng.id : '未配置即梦 CLI'}</span>
          </button>
          {d?.advancedProviderOpen && (
            <div className="grid grid-cols-2 gap-2">
              <select
                className={`${controlCls} w-full`}
                style={inputStyle}
                value={activeJimeng?.id || ''}
                onChange={(e) => update({ providerSource: 'external', providerId: e.target.value })}
              >
                {jimengProviders.length === 0 && <option value="">未配置即梦 CLI</option>}
                {jimengProviders.map((p: any) => <option key={p.id} value={p.id}>{p.label || p.id}</option>)}
              </select>
              <select
                className={`${controlCls} w-full`}
                style={inputStyle}
                value={providerModel}
                onChange={(e) => update({ providerModel: e.target.value })}
              >
                {externalModelOptions.length === 0 && <option value="seedance2.0fast_vip">seedance2.0fast_vip</option>}
                {externalModelOptions.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>
          )}
        </div>

        <div className="grid grid-cols-[minmax(0,2fr)_minmax(76px,0.8fr)_minmax(92px,0.9fr)_auto] items-center gap-1.5">
          <select
            className={`${controlCls} min-w-0`}
            style={inputStyle}
            value={providerModel}
            onChange={(e) => update({ providerModel: e.target.value })}
            title="外部模型"
          >
            {externalModelOptions.length === 0 && <option value="seedance2.0fast_vip">seedance2.0fast_vip</option>}
            {externalModelOptions.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
          <select className={controlCls} style={inputStyle} value={ratio} onChange={(e) => update({ ratio: e.target.value })}>
            {RATIO_OPTIONS.map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
          <select className={controlCls} style={inputStyle} value={resolution} onChange={(e) => update({ resolution: e.target.value })}>
            {RESOLUTION_OPTIONS.map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
          <label className={`${controlCls} flex min-w-[74px] items-center justify-center gap-1 px-1.5`} style={inputStyle} title="生成音频">
            <input type="checkbox" checked={generateAudio} onChange={(e) => update({ generateAudio: e.target.checked })} />
            <span>音频</span>
          </label>
        </div>

        {/* 时间线(镜头块,永远可见) */}
        <div className={cardCls} style={cardStyle}>
          <div className="mb-2 flex items-center justify-between text-[11px]">
            <span className="font-semibold">秒级时间线</span>
            <button type="button" className={btnCls} style={{ borderColor: border }} disabled={!canAddBlock} onClick={addBlock}>
              <Plus size={11} /> 加镜头
            </button>
          </div>
          <div className="mb-2">
            <MentionPromptInput
              title="全局提示词"
              value={globalPrompt}
              mentions={globalPromptMentions}
              materials={mentionMaterials}
              onChange={(value, mentions) => update({ globalPrompt: value, globalPromptMentions: mentions })}
              placeholder="写人设、画风、环境等全局要求；输入 @ 可引用素材"
              isDark={isDark}
              isPixel={isPixel}
              promptTemplateKind="video"
              className="nodrag min-h-[64px] w-full resize-none rounded border px-2 py-1 text-xs outline-none"
              style={inputStyle}
            />
          </div>
          <div ref={timelineRef} className="flex h-14 min-w-0 items-stretch overflow-hidden rounded border nodrag nopan" style={{ borderColor: border }}>
            {blocks.map((b, i) => {
              const isLast = i === blocks.length - 1;
              const active = b.id === activeId;
              const hasPrompt = !!(b.prompt && b.prompt.trim());
              return (
                <Fragment key={b.id}>
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => setActiveId(b.id)}
                    onKeyDown={(ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); setActiveId(b.id); } }}
                    className="nodrag nopan relative min-w-[42px] cursor-pointer border-r px-1 py-1 text-left text-[10px] outline-none transition-colors focus-visible:ring-2"
                    style={{
                      flex: isLast ? 1 : Math.max(1, b.durationSec),
                      borderColor: subBorder,
                      background: active
                        ? 'color-mix(in srgb, var(--t8-accent, #d946ef) 26%, var(--t8-bg-panel, #111827))'
                        : 'var(--t8-bg-panel, rgba(15,23,42,.42))',
                    }}
                    title="点击编辑；拖动右侧小条调整时长"
                  >
                    <div className="truncate font-semibold">{`镜头${i + 1}`}</div>
                    <div style={mutedStyle}>{isLast ? '定格' : `${round1(b.durationSec)}s`}</div>
                    {/* 状态点:有图=绿,无图=黄 */}
                    <span className="absolute bottom-1 left-1 h-1.5 w-1.5 rounded-full" style={{ background: b.imageUrl ? '#34d399' : '#fbbf24' }} title={b.imageUrl ? '已设图' : '未设图'} />
                    {/* 块右缘:拖拽调本镜头时长(末镜头无时长) */}
                    {!isLast && (
                      <button
                        type="button"
                        data-timeline-resize-handle
                        aria-label={`拖动调整 镜头${i + 1} 时长`}
                        className="nodrag nopan absolute -right-1 top-0 z-20 h-full w-4 cursor-ew-resize rounded-sm border-l border-white/20 bg-white/5 opacity-80 transition hover:bg-white/20"
                        style={{ touchAction: 'none' }}
                        onClick={(ev) => ev.stopPropagation()}
                        onPointerDownCapture={(ev) => beginResize(ev, b)}
                        onPointerDown={(ev) => beginResize(ev, b)}
                        onPointerMoveCapture={moveResize}
                        onPointerUpCapture={endResize}
                        onPointerCancelCapture={endResize}
                        onMouseDownCapture={(ev) => beginResize(ev, b)}
                        onMouseDown={(ev) => beginResize(ev, b)}
                        onMouseMoveCapture={moveResize}
                        onMouseUpCapture={endResize}
                      />
                    )}
                  </div>
                  {!isLast && (
                    <button
                      type="button"
                      data-timeline-resize-handle
                      className="nodrag nopan flex w-6 shrink-0 items-center justify-center border-r text-[11px] font-semibold outline-none transition cursor-ew-resize"
                      style={{
                        borderColor: subBorder,
                        touchAction: 'none',
                        color: hasPrompt ? 'var(--t8-accent, #d946ef)' : 'var(--t8-text-muted, rgba(248,250,252,.62))',
                        background: hasPrompt ? 'color-mix(in srgb, var(--t8-accent, #d946ef) 12%, var(--t8-bg-panel, #111827))' : 'transparent',
                      }}
                      title={`点击编辑 镜头${i + 1};拖动调时长`}
                      aria-label={`镜头${i + 1},点击编辑,拖动调时长`}
                      onPointerDownCapture={(ev) => beginSeparator(ev, b)}
                      onMouseDownCapture={(ev) => beginSeparator(ev, b)}
                    >
                      ↔
                    </button>
                  )}
                </Fragment>
              );
            })}
          </div>
          <div className="mt-2 text-[10px]" style={mutedStyle}>点镜头块/拖块缘或↔ 调时长；末镜头只定格、不计时长。总时长 = 前面各镜头时长之和。</div>
        </div>

        {/* LLM 优化条 */}
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-semibold">分镜编辑</span>
          <div className="flex items-center gap-1">
            {activeBlock && !isLastActive && (
              <label className="flex h-9 shrink-0 items-center gap-1 text-[11px]" style={mutedStyle}>
                时长
                <input
                  type="number"
                  step={0.1}
                  min={SEG_MIN}
                  max={SEG_MAX}
                  className={`${controlCls} w-16 text-xs`}
                  style={inputStyle}
                  value={activeBlock.durationSec}
                  onChange={(e) => patchBlock(activeBlock.id, {
                    durationSec: clampTimelineDirectorSegmentDuration(blocks, activeIndex, round1(Number(e.target.value) || 0)),
                  })}
                />
                s
              </label>
            )}
            <select
              className={`${controlCls} max-w-[118px] text-[10px]`}
              style={inputStyle}
              value={llmProviderSelection.providerId || ''}
              onChange={(e) => {
                const provider = llmProviders.find((item) => item.id === e.target.value);
                update({
                  llmProviderSource: provider?.protocol || 'zhenzhen',
                  llmProviderId: provider?.id || '',
                  llmProviderModel: provider ? advancedProviderModelOptions(provider, 'llm')[0] || '' : '',
                });
              }}
              title="LLM 优化平台"
            >
              <option value="">内置LLM</option>
              {llmProviders.map((provider) => <option key={provider.id} value={provider.id}>{provider.label || provider.id}</option>)}
            </select>
            {llmProviderSelection.provider && (
              <select className={`${controlCls} max-w-[110px] text-[10px]`} style={inputStyle} value={llmProviderModel} onChange={(e) => update({ llmProviderModel: e.target.value })} title="LLM 模型">
                {llmModelOptions.map((modelOption) => <option key={modelOption} value={modelOption}>{modelOption}</option>)}
              </select>
            )}
            <select className={`${controlCls} text-[10px]`} style={inputStyle} value={llmMode} onChange={(e) => update({ llmMode: e.target.value })}>
              <option value="segment">分段优化</option>
              <option value="full">全文优化</option>
            </select>
            <button type="button" className={btnCls} style={{ borderColor: border }} disabled={optimizing} onClick={handleOptimize}>
              {optimizing ? <Loader2 size={11} className="animate-spin" /> : <Wand2 size={11} />} LLM优化
            </button>
          </div>
        </div>

        {/* 选中镜头编辑面板 */}
        {activeBlock ? (
          <div className={cardCls} style={cardStyle} onKeyDownCapture={stopDeleteFromCanvas}>
            {/* 缩略图 */}
            <div className="relative mb-2 flex h-28 w-full items-center justify-center overflow-hidden rounded border" style={{ borderColor: subBorder, background: 'rgba(0,0,0,.2)' }}>
              <input
                aria-label="图名"
                className="nodrag absolute left-2 top-2 z-10 h-6 max-w-[180px] rounded border border-white/15 bg-black/55 px-1.5 text-[10px] font-semibold text-white outline-none"
                value={activeBlock.imageName}
                placeholder="图名"
                onChange={(e) => patchBlock(activeBlock.id, { imageName: sanitizeTimelineImageName(e.target.value, activeBlock.imageUrl, activeIndex) })}
              />
              {activeBlock.imageUrl ? <SmartImage src={activeBlock.imageUrl} alt="" className="h-full w-full object-contain" /> : <span className="text-[11px] opacity-40">未设图片</span>}
            </div>

            {/* 换图来源 */}
            <div className="grid grid-cols-3 gap-1.5">
              <button type="button" className={btnCls} style={{ borderColor: border }} onClick={() => uploadImageRef.current?.click()}><ImageIcon size={13} /> 上传图</button>
              <button type="button" className={btnCls} style={{ borderColor: border }} onClick={() => uploadVideoRef.current?.click()}><VideoIcon size={13} /> 上传视频</button>
              <button type="button" className={btnCls} style={{ borderColor: border }} onClick={() => uploadAudioRef.current?.click()}><Music size={13} /> 上传音频</button>
            </div>
            <div className="mt-1.5 grid grid-cols-3 gap-1.5">
              <button type="button" className={btnCls} style={{ borderColor: border }} onClick={() => openResourcePicker('image')}><Library size={13} /> 资源图</button>
              <button type="button" className={btnCls} style={{ borderColor: border }} onClick={() => openResourcePicker('video')}><Library size={13} /> 资源视频</button>
              <button type="button" className={btnCls} style={{ borderColor: border }} onClick={() => openResourcePicker('audio')}><Library size={13} /> 资源音频</button>
            </div>

            <input ref={uploadImageRef} type="file" accept="image/*" multiple className="hidden" onChange={(event) => handleUpload('image', event)} />
            <input ref={uploadVideoRef} type="file" accept="video/*" multiple className="hidden" onChange={(event) => handleUpload('video', event)} />
            <input ref={uploadAudioRef} type="file" accept="audio/*" multiple className="hidden" onChange={(event) => handleUpload('audio', event)} />

            {/* 描述(末镜头无) */}
            {!isLastActive && (
              <div>
                <div className="mb-1 text-[10px]" style={mutedStyle}>描述词</div>
                <MentionPromptInput
                  value={activeBlock.prompt}
                  mentions={activeBlock.mentions}
                  materials={mentionMaterials}
                  onChange={(value, mentions) => patchBlock(activeBlock.id, { prompt: value, mentions })}
                  placeholder="写这个镜头到下一镜头的画面、动作、镜头语言；输入 @ 可引用素材"
                  isDark={isDark}
                  isPixel={isPixel}
                  expandable
                  promptTemplateKind="video"
                  title="描述词"
                />
              </div>
            )}

            {/* 镜头操作 */}
            <div className="grid grid-cols-4 gap-1.5 mt-2">
              <button type="button" disabled={activeIndex === 0} className={btnCls} style={{ borderColor: border }} onClick={() => moveBlock(activeBlock.id, -1)}><ArrowLeft size={12} /> 左移</button>
              <button type="button" disabled={activeIndex === blocks.length - 1} className={btnCls} style={{ borderColor: border }} onClick={() => moveBlock(activeBlock.id, 1)}>右移 <ArrowRight size={12} /></button>
              <button type="button" disabled={!canAddBlock} className={btnCls} style={{ borderColor: border }} onClick={() => duplicateBlock(activeBlock.id)}><Copy size={12} /> 复制</button>
              <button type="button" disabled={blocks.length <= 2} className={btnCls} style={{ borderColor: border }} onClick={() => removeBlock(activeBlock.id)}><Trash2 size={12} className="text-rose-400" /> 删除</button>
            </div>
          </div>
        ) : (
          <div className="text-[11px] opacity-50 text-center py-2">点上方镜头块进行编辑</div>
        )}

        <details className={cardCls} style={cardStyle}>
          <summary className="cursor-pointer text-[11px]" style={mutedStyle}>实际发送({blocks.length}镜头 / {totalDuration}s)</summary>
          <div className="mt-2 space-y-1 text-[10px]" style={mutedStyle}>
            <div className="rounded border px-2 py-1" style={{ borderColor: subBorder }}>
              图片：{compiled.images.filter(Boolean).length} 张，全部真实发送给即梦
            </div>
            {(compiled.videos.length > 0 || compiled.audios.length > 0) && (
              <div className="rounded border px-2 py-1" style={{ borderColor: subBorder }}>
                全局参考：{compiled.videos.length} 视频 / {compiled.audios.length} 音频
              </div>
            )}
            <div className="font-semibold">Prompt</div>
            <div className="whitespace-pre-wrap">{compiled.prompt || '(空)'}</div>
          </div>
        </details>

        {error && <div className="flex items-start gap-1 text-[11px] text-rose-400"><AlertCircle size={13} className="mt-0.5 shrink-0" /> {error}</div>}
        {!totalValid && blocks.length >= 2 && imagedCount < blocks.length && <div className="text-[10px] text-amber-400">还有 {blocks.length - imagedCount} 个镜头未设图</div>}
        {!totalValid && imagedCount === blocks.length && (totalDuration < MIN_TOTAL || totalDuration > MAX_TOTAL) && <div className="text-[10px] text-amber-400">总时长 {totalDuration}s 需在 {MIN_TOTAL}-{MAX_TOTAL}s</div>}
        {!totalValid && imagedCount === blocks.length && totalRequestImages > MAX_IMAGES && <div className="text-[10px] text-amber-400">图片总数 {totalRequestImages} 张，需不超过 {MAX_IMAGES} 张</div>}

        {latestVideoUrl && <div className="rounded-lg overflow-hidden border" style={{ borderColor: border }}><LoopingVideo src={latestVideoUrl} className="w-full" /></div>}

        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={running ? undefined : handleGenerate}
            disabled={!totalValid || running}
            className="nodrag flex h-10 items-center justify-center gap-1.5 rounded-md border px-3 py-2 text-xs font-semibold disabled:opacity-50"
            style={{
              borderColor: 'var(--t8-accent, #d946ef)',
              background: totalValid
                ? 'linear-gradient(135deg, color-mix(in srgb, var(--t8-accent, #d946ef) 80%, #111827), color-mix(in srgb, var(--t8-accent-2, #22d3ee) 70%, #111827))'
                : 'var(--t8-bg-panel, rgba(15,23,42,.52))',
              color: totalValid ? '#fff' : 'var(--t8-text-muted, rgba(248,250,252,.62))',
            }}
          >
            {running ? <><Loader2 size={14} className="animate-spin" /> 生成中 {mmss}</> : <><Sparkles size={14} /> 生成全部</>}
          </button>
          <div className="flex h-10 items-center gap-2 rounded-md border px-2 py-2 text-[11px]" style={{ borderColor: subBorder }}>
            {running ? <Loader2 size={13} className="animate-spin" /> : <Wand2 size={13} />}
            <span className="truncate" style={mutedStyle}>
              已输出 {currentOutputCount} / 1
            </span>
            <button
              type="button"
              onClick={refreshOutputs}
              disabled={!latestVideoUrl}
              className="nodrag ml-auto shrink-0 rounded border px-1.5 py-0.5 text-[10px] disabled:opacity-40"
              style={{ borderColor: border, color: 'var(--t8-text-main, #f8fafc)' }}
              title="不重新提交任务，仅重新整理已完成的视频输出"
            >
              重新获取
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default memo(TimelineDirectorNode);
