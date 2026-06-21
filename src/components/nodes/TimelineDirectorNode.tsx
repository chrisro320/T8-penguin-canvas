import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { AlertCircle, ArrowLeft, ArrowRight, Check, Clapperboard, Copy, Eye, Image as ImageIcon, Library, Loader2, Music, PanelRightOpen, Plus, RefreshCw, Search, Send, Sparkles, TerminalSquare, Trash2, Video as VideoIcon, Wand2, X } from 'lucide-react';
import {
  generateExternalVideo,
  uploadFile,
} from '../../services/generation';
import { getCodexCliSkills, getCodexCliStatus, streamCodexCliAgent, type CodexCliStatus, type CodexSkill } from '../../services/codexCli';
import { streamCodexImageConjure } from '../../services/codexImageConjure';
import { opGridCrop } from '../../services/imageOps';
import { useUpdateNodeData } from './useUpdateNodeData';
import { PORT_COLOR } from '../../config/portTypes';
import { useThemeStore } from '../../stores/theme';
import { logBus } from '../../stores/logs';
import { useUpstreamMaterials, type Material } from './useUpstreamMaterials';
import MaterialPreviewSection from './MaterialPreviewSection';
import MentionPromptInput from './MentionPromptInput';
import LoopingVideo from '../LoopingVideo';
import SmartImage from '../SmartImage';
import { materialMentionKey, resolveMediaMentions, type MediaMention } from './mediaMentions';
import { countExcludedMaterials, excludeMaterialId, filterExcludedMaterials, normalizeExcludedMaterialIds } from '../../utils/materialExclusion';
import * as api from '../../services/api';
import { taskCompletionSound } from '../../stores/taskCompletionSound';
import { useApiKeysStore } from '../../stores/apiKeys';
import { useOrderedMaterials } from './useOrderedMaterials';
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
  buildTimelineDirectorAgentPlanPrompt,
  buildTimelineDirectorCompiledPrompt,
  buildTimelineDirectorSegments,
  clampTimelineDirectorSegmentDuration,
  extractTimelineDirectorAgentPlanJson,
  normalizeTimelineDirectorAgentPlan,
  normalizeTimelineDirectorTotalDuration,
  sanitizeTimelineDirectorBlocks,
  sanitizeTimelineImageName,
  timelineDirectorTotalDuration,
  type TimelineDirectorBlock,
  type TimelineDirectorBlockInput,
} from '../../utils/timelineDirector';

/**
 * TimelineDirectorNode — 单段视频 · 时间轴导演
 * 时间线由 1-9 个镜头组成,每个镜头 = 一张真实图片 + 时长与描述。
 * 生成时按即梦能力把图片真实传入,完整 prompt 只发送一段。
 */

const MAX_IMAGES = 9;
const MIN_TOTAL = TIMELINE_DIRECTOR_MIN_TOTAL_DURATION_SEC;
const MAX_TOTAL = TIMELINE_DIRECTOR_MAX_TOTAL_DURATION_SEC;
const SEG_MIN = TIMELINE_DIRECTOR_MIN_SEGMENT_DURATION_SEC;
const SEG_MAX = TIMELINE_DIRECTOR_MAX_SEGMENT_DURATION_SEC;
const TIMELINE_CODEX_DEFAULT_MODEL = 'gpt-5.4-mini';
const TIMELINE_CODEX_CONTEXT_DEFAULT_LIMIT = 30;
const TIMELINE_CODEX_CONTEXT_MAX_LIMIT = 80;
const RATIO_OPTIONS = ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9', '9:21', 'adaptive'];
const RESOLUTION_OPTIONS = ['480p', '720p', 'native1080p', '1080p', '2k', '4k'];
const CODEX_MODEL_OPTIONS = [
  { value: TIMELINE_CODEX_DEFAULT_MODEL, label: 'GPT-5.4 mini' },
  { value: 'gpt-5.4', label: 'GPT-5.4' },
  { value: 'gpt-5.5', label: 'GPT-5.5' },
  { value: 'default', label: '默认模型' },
];
const TIMELINE_HANDLE_GAP = 34;
const timelineHandleStyle = {
  width: 15,
  height: 15,
  border: '2px solid rgba(255,255,255,0.92)',
  boxShadow: '0 0 0 2px rgba(8,18,34,0.86), 0 0 12px rgba(217,70,239,0.35)',
  zIndex: 120,
};

type Block = TimelineDirectorBlock;
type ReferenceKind = 'image' | 'video' | 'audio';

const SEG_STEP = 0.1;
const genId = (p: string) => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const round1 = (v: number) => Math.round(v * 10) / 10;
type CodexStudioRunMode = 'normal' | 'storyboardQuickSplit';
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

function timelineHandleTop(index: number, count: number): string {
  const offset = Math.round((index - (count - 1) / 2) * TIMELINE_HANDLE_GAP);
  if (offset === 0) return '50%';
  return `calc(50% ${offset > 0 ? '+' : '-'} ${Math.abs(offset)}px)`;
}

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

function parseExtraArgs(value: any): string[] {
  if (Array.isArray(value)) return dedupe(value.map((item) => String(item || '').trim()));
  const text = String(value || '').trim();
  if (!text) return [];
  return text.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((item) => item.replace(/^"|"$/g, '')) || [];
}

function normalizeSkillKey(name: string) {
  return String(name || '').replace(/^\$/, '').trim().toLowerCase();
}

function skillPurposeLabel(skill: CodexSkill): string {
  const desc = String(skill.description || '').trim();
  if (/image|bitmap|photo|visual|picture|generate|edit/i.test(desc)) return '图像生成、编辑或视觉方案相关 Skill。';
  if (/design|layout|figma|prototype|component|ui/i.test(desc)) return '设计、排版、界面或原型相关 Skill。';
  if (/presentation|slide|deck|ppt/i.test(desc)) return '演示文稿和提案排版相关 Skill。';
  if (/document|copy|writing|script|story|brief|prompt/i.test(desc)) return '文案、脚本、提示词或创作说明相关 Skill。';
  if (desc) return desc.length > 88 ? `${desc.slice(0, 88)}...` : desc;
  return skill.scope === 'project' ? '当前项目自定义创作 Skill。' : '可由 Codex 调用的扩展能力。';
}

function scoreSkillMatch(skill: CodexSkill, rawQuery: string) {
  const query = normalizeSkillKey(rawQuery).replace(/^\//, '');
  if (!query) return 0;
  const name = normalizeSkillKey(skill.name);
  const shortName = normalizeSkillKey(name.split(':').pop() || name);
  const description = String(skill.description || '').toLowerCase();
  const purpose = skillPurposeLabel(skill).toLowerCase();
  if (name === query || shortName === query) return 1;
  if (name.startsWith(query) || shortName.startsWith(query)) return 2;
  if (name.includes(query) || shortName.includes(query)) return 3;
  if (description.includes(query)) return 5;
  if (purpose.includes(query)) return 6;
  return Number.POSITIVE_INFINITY;
}

function timelineStoryboardGridLayout(count: number): { rows: number; cols: number } {
  const n = Math.max(1, Math.min(MAX_IMAGES, Math.floor(Number(count) || 1)));
  if (n === 1) return { rows: 1, cols: 1 };
  if (n === 2) return { rows: 1, cols: 2 };
  if (n <= 4) return { rows: 2, cols: 2 };
  if (n <= 6) return { rows: 2, cols: 3 };
  return { rows: 3, cols: 3 };
}

function timelineGridAspectRatio(layout: { rows: number; cols: number }, targetRatio: string): string {
  if (!targetRatio.includes(':')) return targetRatio || '16:9';
  const [w, h] = targetRatio.split(':').map((part) => Number(part));
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return targetRatio;
  return `${Math.round(w * layout.cols)}:${Math.round(h * layout.rows)}`;
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
  const [agentExecuting, setAgentExecuting] = useState(false);
  const [agentMessage, setAgentMessage] = useState('');
  // 在途 Codex 流的运行 token + AbortController: 切会话/切节点时作废旧运行, 防止旧流式 delta
  // 继续写入(串台到新会话)。每次发起运行自增 token, 回调写入前用闭包内的 token 做守卫。
  const agentRunTokenRef = useRef(0);
  const agentRunControllerRef = useRef<AbortController | null>(null);
  const cancelActiveAgentRun = () => {
    agentRunTokenRef.current += 1;
    try { agentRunControllerRef.current?.abort(); } catch { /* ignore */ }
    agentRunControllerRef.current = null;
    // 作废在途运行后, 其 finally 因 token 已变不会复位执行态, 这里主动收口避免转圈卡死。
    setAgentExecuting(false);
  };
  const [resourcePickerKind, setResourcePickerKind] = useState<ReferenceKind | null>(null);
  const [resourceItems, setResourceItems] = useState<api.ResourceItem[]>([]);
  const [resourceQuery, setResourceQuery] = useState('');
  const [resourceLoading, setResourceLoading] = useState(false);
  const [resourceMessage, setResourceMessage] = useState('');
  const [activeId, setActiveId] = useState<string | null>(null);
  const [previewImageUrl, setPreviewImageUrl] = useState('');
  const [codexSkills, setCodexSkills] = useState<CodexSkill[]>([]);
  const [codexSkillLoading, setCodexSkillLoading] = useState(false);
  const [skillPickerOpen, setSkillPickerOpen] = useState(false);
  const [skillSearchQuery, setSkillSearchQuery] = useState('');
  const [skillPickerAnchor, setSkillPickerAnchor] = useState<{ left: number; top: number; width: number } | null>(null);
  const [codexStatus, setCodexStatus] = useState<CodexCliStatus | null>(null);
  const [codexStatusLoading, setCodexStatusLoading] = useState(false);
  const [codexStudioOpen, setCodexStudioOpen] = useState(false);
  const [keyframeStudioOpen, setKeyframeStudioOpen] = useState(false);
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
  const ratio: string = d.ratio || '16:9';
  const resolution: string = d.resolution || '2k';
  const codexSessionId = String(d.codexSessionId || `${id}:timeline-default`);
  const codexAgentTaskPrompt = typeof d.codexAgentTaskPrompt === 'string' ? d.codexAgentTaskPrompt : '';
  const codexAgentTaskPromptMentions: MediaMention[] = Array.isArray(d.codexAgentTaskPromptMentions) ? d.codexAgentTaskPromptMentions : [];
  const agentStoryboardOutputUrls = useMemo(() => dedupe(Array.isArray(d.agentStoryboardOutputUrls) ? d.agentStoryboardOutputUrls : []), [d.agentStoryboardOutputUrls]);
  const agentStoryboardGridImageUrl = String(d.agentStoryboardGridImageUrl || '').trim();
  const agentStoryboardPlanText = String(d.agentStoryboardPlanText || '').trim();
  const agentStoryboardLog = useMemo(
    () => (Array.isArray(d.agentStoryboardLog) ? d.agentStoryboardLog.map((item: any) => String(item || '').trim()).filter(Boolean) : []),
    [d.agentStoryboardLog],
  );
  const codexTimelineSessions = useMemo(
    () => (Array.isArray(d.codexTimelineSessions) ? d.codexTimelineSessions : [])
      .map((item: any) => ({
        id: String(item?.id || '').trim(),
        title: String(item?.title || '当前会话').trim(),
        updatedAt: Number(item?.updatedAt) || Date.now(),
        messageCount: Number(item?.messageCount) || 0,
        artifactCount: Number(item?.artifactCount) || 0,
        snapshot: item?.snapshot && typeof item.snapshot === 'object' ? item.snapshot : {},
      }))
      .filter((item: any) => item.id),
    [d.codexTimelineSessions],
  );
  const selectedCodexSkillNames = useMemo(
    () => Array.isArray(d.codexSelectedSkillNames)
      ? d.codexSelectedSkillNames.map((item: any) => String(item || '').trim()).filter(Boolean)
      : [],
    [d.codexSelectedSkillNames],
  );
  const sortedCodexSkills = useMemo(() => {
    const selected = new Set(selectedCodexSkillNames);
    return [...codexSkills].sort((a, b) => {
      const aSelected = selected.has(a.name);
      const bSelected = selected.has(b.name);
      if (aSelected !== bSelected) return aSelected ? -1 : 1;
      return a.name.localeCompare(b.name, 'zh-CN');
    });
  }, [codexSkills, selectedCodexSkillNames]);
  const filteredCodexSkills = useMemo(() => {
    const query = skillSearchQuery.trim();
    if (!query) return sortedCodexSkills;
    return sortedCodexSkills
      .map((skill) => ({ skill, score: scoreSkillMatch(skill, query) }))
      .filter((item) => Number.isFinite(item.score))
      .sort((a, b) => a.score - b.score || a.skill.name.localeCompare(b.skill.name, 'zh-CN'))
      .map((item) => item.skill);
  }, [skillSearchQuery, sortedCodexSkills]);
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
  const materialOrder = Array.isArray(d.materialOrder) ? d.materialOrder : [];
  const excludedMaterialIds = useMemo(
    () => normalizeExcludedMaterialIds(d.excludedMaterialIds),
    [d.excludedMaterialIds],
  );
  const visibleUpstreamTexts = useMemo(() => filterExcludedMaterials(upstream.texts, excludedMaterialIds), [excludedMaterialIds, upstream.texts]);
  const visibleUpstreamImages = useMemo(() => filterExcludedMaterials(upstream.images, excludedMaterialIds), [excludedMaterialIds, upstream.images]);
  const visibleUpstreamVideos = useMemo(() => filterExcludedMaterials(upstream.videos, excludedMaterialIds), [excludedMaterialIds, upstream.videos]);
  const visibleUpstreamAudios = useMemo(() => filterExcludedMaterials(upstream.audios, excludedMaterialIds), [excludedMaterialIds, upstream.audios]);
  const orderedInputTexts = useOrderedMaterials(visibleUpstreamTexts, materialOrder);
  const orderedInputImages = useOrderedMaterials(visibleUpstreamImages, materialOrder);
  const orderedInputVideos = useOrderedMaterials(visibleUpstreamVideos, materialOrder);
  const orderedInputAudios = useOrderedMaterials(visibleUpstreamAudios, materialOrder);
  const excludedUpstreamCount = useMemo(
    () => countExcludedMaterials(excludedMaterialIds, [...upstream.texts, ...upstream.images, ...upstream.videos, ...upstream.audios]),
    [excludedMaterialIds, upstream.texts, upstream.images, upstream.videos, upstream.audios],
  );
  const inputMaterialTotal = orderedInputTexts.length + orderedInputImages.length + orderedInputVideos.length + orderedInputAudios.length;
  const setMaterialOrder = useCallback((nextOrder: string[]) => update({ materialOrder: nextOrder }), [update]);
  const excludeUpstreamMaterial = useCallback((material: Material) => {
    if (material.origin !== 'upstream') return;
    update({
      excludedMaterialIds: excludeMaterialId(excludedMaterialIds, material.id),
      materialOrder: materialOrder.filter((itemId: string) => itemId !== material.id),
    });
  }, [excludedMaterialIds, materialOrder, update]);
  const restoreExcludedMaterials = useCallback(() => update({ excludedMaterialIds: [] }), [update]);
  const localRefImages = useMemo(() => dedupe(Array.isArray(d.localRefImages) ? d.localRefImages : []), [d.localRefImages]);
  const localRefVideos = useMemo(() => dedupe(Array.isArray(d.localRefVideos) ? d.localRefVideos : []), [d.localRefVideos]);
  const localRefAudios = useMemo(() => dedupe(Array.isArray(d.localRefAudios) ? d.localRefAudios : []), [d.localRefAudios]);
  const localMaterials = useMemo<Material[]>(
    () => [
      ...localRefImages.map((url, index) => ({
        id: `${id}:timeline-local-image:${index}:${url}`,
        kind: 'image' as const,
        url,
        sourceNodeId: id,
        origin: 'local' as const,
        label: `素材图${index + 1}`,
      })),
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
        label: `素材视频${index + 1}`,
      })),
      ...localRefAudios.map((url, index) => ({
        id: `${id}:timeline-local-audio:${index}:${url}`,
        kind: 'audio' as const,
        url,
        sourceNodeId: id,
        origin: 'local' as const,
        label: `素材音频${index + 1}`,
      })),
    ],
    [blocks, id, localRefImages, localRefVideos, localRefAudios],
  );
  const agentMaterials = useMemo<Material[]>(
    () => [
      ...(agentStoryboardGridImageUrl ? [{
        id: `${id}:timeline-agent-grid:${agentStoryboardGridImageUrl}`,
        kind: 'image' as const,
        url: agentStoryboardGridImageUrl,
        sourceNodeId: id,
        origin: 'local' as const,
        label: '脚本快拆宫格图',
        mentionKey: `timeline-agent-grid:${agentStoryboardGridImageUrl}`,
      }] : []),
      ...agentStoryboardOutputUrls.map((url, index) => ({
        id: `${id}:timeline-agent-shot:${index}:${url}`,
        kind: 'image' as const,
        url,
        sourceNodeId: id,
        origin: 'local' as const,
        label: `快拆镜头${index + 1}`,
        mentionKey: `timeline-agent-shot:${index}:${url}`,
      })),
      ...(agentStoryboardPlanText ? [{
        id: `${id}:timeline-agent-plan`,
        kind: 'text' as const,
        url: agentStoryboardPlanText,
        sourceNodeId: id,
        origin: 'local' as const,
        label: '脚本快拆计划',
        mentionKey: `${id}:timeline-agent-plan`,
      }] : []),
    ],
    [agentStoryboardGridImageUrl, agentStoryboardOutputUrls, agentStoryboardPlanText, id],
  );
  const mentionMaterials = useMemo(
    () => [...orderedInputTexts, ...orderedInputImages, ...orderedInputVideos, ...orderedInputAudios, ...localMaterials, ...agentMaterials],
    [orderedInputTexts, orderedInputImages, orderedInputVideos, orderedInputAudios, localMaterials, agentMaterials],
  );
  const upstreamTextContext = useMemo(
    () => orderedInputTexts.map((item) => item.url).filter(Boolean).join('\n\n').trim(),
    [orderedInputTexts],
  );
  const globalPrompt: string = typeof d.globalPrompt === 'string' ? d.globalPrompt : '';
  const globalPromptMentions: MediaMention[] = Array.isArray(d.globalPromptMentions) ? d.globalPromptMentions : [];

  const totalDuration = useMemo(
    () => timelineDirectorTotalDuration(blocks),
    [blocks],
  );
  const imagedCount = blocks.filter((b) => b.imageUrl).length;
  const canAddBlock = blocks.length < MAX_IMAGES && totalDuration < MAX_TOTAL;
  const activeIndex = blocks.findIndex((b) => b.id === activeId);
  const activeBlock = activeIndex >= 0 ? blocks[activeIndex] : null;

  useEffect(() => {
    if (blocks.length > 0 && !blocks.some((block) => block.id === activeId)) {
      setActiveId(blocks[0].id);
    }
  }, [activeId, blocks]);

  useEffect(() => {
    let cancelled = false;
    setCodexSkillLoading(true);
    void getCodexCliSkills({
      nodeId: id,
      sessionId: codexSessionId,
      workspaceDir: String(d.codexWorkspaceDir || '').trim(),
    })
      .then((result) => {
        if (cancelled) return;
        setCodexSkills(Array.isArray(result.skills) ? result.skills : []);
        if (result.workspaceDir && result.workspaceDir !== d.codexWorkspaceDir) update({ codexWorkspaceDir: result.workspaceDir });
      })
      .catch((skillError: any) => {
        if (!cancelled) logBus.warn(skillError?.message || 'Codex 技能读取失败', src);
      })
      .finally(() => {
        if (!cancelled) setCodexSkillLoading(false);
      });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, codexSessionId, d.codexWorkspaceDir]);

  const refreshCodexStatus = async () => {
    setCodexStatusLoading(true);
    try {
      const status = await getCodexCliStatus(String(d.codexExecutablePath || '').trim());
      setCodexStatus(status);
      if (!status.available && status.message) logBus.warn(status.message, src);
    } catch (statusError: any) {
      const message = statusError?.message || 'Codex CLI 状态读取失败';
      setCodexStatus({ available: false, message });
      logBus.warn(message, src);
    } finally {
      setCodexStatusLoading(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    setCodexStatusLoading(true);
    void getCodexCliStatus(String(d.codexExecutablePath || '').trim())
      .then((status) => {
        if (!cancelled) setCodexStatus(status);
      })
      .catch((statusError: any) => {
        if (!cancelled) setCodexStatus({ available: false, message: statusError?.message || 'Codex CLI 状态读取失败' });
      })
      .finally(() => {
        if (!cancelled) setCodexStatusLoading(false);
      });
    return () => { cancelled = true; };
  }, [d.codexExecutablePath]);

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
    if (blocks.length <= 1) { setError('至少保留 1 个镜头'); return; }
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
  const toggleCodexSkill = (name: string) => {
    const clean = String(name || '').trim();
    if (!clean) return;
    const next = selectedCodexSkillNames.includes(clean)
      ? selectedCodexSkillNames.filter((item: string) => item !== clean)
      : [...selectedCodexSkillNames, clean];
    update({ codexSelectedSkillNames: next });
  };
  const openSkillPicker = (target?: HTMLElement | null, query = '') => {
    const rect = target?.getBoundingClientRect();
    const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 1200;
    const viewportHeight = typeof window !== 'undefined' ? window.innerHeight : 800;
    const width = Math.min(Math.max(rect?.width || 360, 340), Math.min(560, viewportWidth - 24));
    const left = Math.min(Math.max(12, rect?.left || 24), Math.max(12, viewportWidth - width - 12));
    const top = Math.min(Math.max(12, (rect?.bottom ?? 120) + 8), Math.max(12, viewportHeight - 420));
    setSkillSearchQuery(query);
    setSkillPickerAnchor({ left, top, width });
    setSkillPickerOpen(true);
  };
  const closeSkillPicker = () => setSkillPickerOpen(false);
  const chooseSkillFromPicker = (skill: CodexSkill) => {
    toggleCodexSkill(skill.name);
  };
  const currentTimelineSessionSnapshot = () => ({
    agentMessage: String(d.agentMessage || agentMessage || ''),
    agentStoryboardMessage: String(d.agentStoryboardMessage || ''),
    agentStoryboardLog,
    agentStoryboardOutputUrls,
    agentStoryboardGridImageUrl,
    agentStoryboardPlanText,
    agentStoryboardOutputCount: Number(d.agentStoryboardOutputCount) || agentStoryboardOutputUrls.length,
    agentStoryboardStatus: String(d.agentStoryboardStatus || 'idle'),
    outputText: String(d.outputText || ''),
    text: String(d.text || ''),
    reply: String(d.reply || ''),
    imageUrl: String(d.imageUrl || ''),
    imageUrls: Array.isArray(d.imageUrls) ? d.imageUrls : [],
  });
  const saveCurrentTimelineSession = (nextSessionId = codexSessionId) => {
    const snapshot = currentTimelineSessionSnapshot();
    const nextEntry = {
      id: nextSessionId,
      title: snapshot.agentMessage || snapshot.agentStoryboardPlanText ? '当前会话' : '新会话',
      updatedAt: Date.now(),
      messageCount: agentStoryboardLog.length,
      artifactCount: agentStoryboardOutputUrls.length + (agentStoryboardGridImageUrl ? 1 : 0) + (agentStoryboardPlanText ? 1 : 0),
      snapshot,
    };
    return [nextEntry, ...codexTimelineSessions.filter((session: any) => session.id !== nextSessionId)].slice(0, 12);
  };
  const startNewTimelineSession = () => {
    cancelActiveAgentRun();
    const nextSessionId = genId(`${id}:timeline-session`);
    const now = new Date().toLocaleTimeString();
    const nextMessage = buildCodexConversation('', `已新建 Codex 后端会话：${nextSessionId}`, {
      modeLabel: '新会话',
      logs: [`${now} 新建会话`],
    });
    setAgentMessage(nextMessage);
    update({
      codexSessionId: nextSessionId,
      codexTimelineSessionTitle: `新会话 ${now}`,
      codexTimelineSessions: saveCurrentTimelineSession(),
      agentMessage: nextMessage,
      agentStoryboardMessage: `已新建 Codex 后端会话：${nextSessionId}`,
      agentStoryboardLog: [`${now} 新建会话`],
      agentStoryboardOutputUrls: [],
      agentStoryboardGridImageUrl: '',
      agentStoryboardPlanText: '',
      agentStoryboardOutputCount: 0,
      agentStoryboardStatus: 'idle',
      outputText: '',
      text: '',
      reply: '',
      imageUrl: '',
      imageUrls: [],
    });
    logBus.info(`时间轴导演 Codex 新建会话: ${nextSessionId}`, src);
  };
  const restoreTimelineSession = (session: { id: string; snapshot: Record<string, any> }) => {
    cancelActiveAgentRun();
    const snapshot = session.snapshot || {};
    setAgentMessage(String(snapshot.agentMessage || ''));
    update({
      codexSessionId: session.id,
      codexTimelineSessions: saveCurrentTimelineSession(),
      agentMessage: String(snapshot.agentMessage || ''),
      agentStoryboardMessage: String(snapshot.agentStoryboardMessage || ''),
      agentStoryboardLog: Array.isArray(snapshot.agentStoryboardLog) ? snapshot.agentStoryboardLog : [],
      agentStoryboardOutputUrls: Array.isArray(snapshot.agentStoryboardOutputUrls) ? snapshot.agentStoryboardOutputUrls : [],
      agentStoryboardGridImageUrl: String(snapshot.agentStoryboardGridImageUrl || ''),
      agentStoryboardPlanText: String(snapshot.agentStoryboardPlanText || ''),
      agentStoryboardOutputCount: Number(snapshot.agentStoryboardOutputCount) || 0,
      agentStoryboardStatus: String(snapshot.agentStoryboardStatus || 'idle'),
      outputText: String(snapshot.outputText || ''),
      text: String(snapshot.text || ''),
      reply: String(snapshot.reply || ''),
      imageUrl: String(snapshot.imageUrl || ''),
      imageUrls: Array.isArray(snapshot.imageUrls) ? snapshot.imageUrls : [],
    });
  };
  const createNewTimelineWorkspace = () => {
    cancelActiveAgentRun();
    const nextSessionId = genId(`${id}:timeline-workspace`);
    setCodexSkills([]);
    setAgentMessage('');
    update({
      codexSessionId: nextSessionId,
      codexWorkspaceDir: '',
      codexTimelineSessionTitle: '当前会话',
      codexTimelineSessions: [],
      agentMessage: '',
      agentStoryboardMessage: '已准备新工作区；下次刷新或发送会让后端按新会话创建/复用工作区。',
      agentStoryboardLog: [],
      agentStoryboardOutputUrls: [],
      agentStoryboardGridImageUrl: '',
      agentStoryboardPlanText: '',
      agentStoryboardOutputCount: 0,
      agentStoryboardStatus: 'idle',
      outputText: '',
      text: '',
      reply: '',
      imageUrl: '',
      imageUrls: [],
    });
    logBus.info(`时间轴导演 Codex 新建工作区会话: ${nextSessionId}`, src);
  };
  const archiveTimelineSessions = () => {
    const current = saveCurrentTimelineSession(codexSessionId)[0];
    const archivedCount = Math.max(0, codexTimelineSessions.length);
    update({
      codexTimelineSessions: [current],
      codexArchivedSessionCount: Number(d.codexArchivedSessionCount || 0) + archivedCount,
      agentStoryboardMessage: archivedCount > 0 ? `已归档 ${archivedCount} 个旧会话` : '没有需要归档的旧会话',
    });
  };
  useEffect(() => {
    if (!skillPickerOpen || typeof document === 'undefined') return undefined;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target?.closest?.('[data-timeline-codex-skill-picker]') ||
        target?.closest?.('[data-timeline-codex-skill-trigger]')
      ) {
        return;
      }
      closeSkillPicker();
    };
    document.addEventListener('mousedown', onPointerDown, true);
    return () => document.removeEventListener('mousedown', onPointerDown, true);
  }, [skillPickerOpen]);
  const setActiveImage = (url: string, name?: string) => {
    if (!activeBlock) return;
    const patch: Partial<Block> = { imageUrl: url };
    if (!activeBlock.imageName || /^(frame|shot)\d+$/i.test(activeBlock.imageName) || /^镜头\d+$/i.test(activeBlock.imageName)) {
      patch.imageName = sanitizeTimelineImageName(name || activeBlock.title, url, activeIndex);
    }
    patchBlock(activeBlock.id, patch);
  };
  const appendRefs = (kind: ReferenceKind, urls: string[]) => {
    const clean = dedupe(urls);
    if (!clean.length) return;
    if (kind === 'image') {
      update({ localRefImages: dedupe([...localRefImages, ...clean]) });
      return;
    }
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
    appendRefs(resourcePickerKind, [item.fileUrl]);
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

  // === Codex Agent 调用 ===
  const callCodexAgent = async (
    system: string,
    user: string,
    options: { referenceImages: string[]; referenceVideos: string[]; referenceAudios: string[]; referenceTexts: string[]; signal?: AbortSignal },
  ): Promise<string> => {
    const result = await streamCodexCliAgent({
      nodeId: id,
      sessionId: codexSessionId,
      mode: 'storyboard',
      command: '/chat',
      preset: '时间轴导演台',
      prompt: [
        system,
        '本轮交给 LLM 做脚本理解和镜头拆分：读取元脚本、分析参考图、拆解镜头，输出可机读 JSON。不要在规划阶段生成图片，不要写代码，不要调用 image_generation；图文生图转交后续 image2 / image_generation 阶段逐镜头执行。',
        '图片会作为真实多模态输入传给 Codex。请结合图片内容理解 @图片名 的语义，不要把 @图片名 替换成 URL 或普通解释。',
        codexAgentTaskPrompt ? `用户元脚本：\n${codexAgentTaskPrompt}` : '',
        user,
      ].filter(Boolean).join('\n\n'),
      referenceTexts: options.referenceTexts,
      images: options.referenceImages,
      videos: options.referenceVideos,
      audios: options.referenceAudios,
      selectedSkillNames: selectedCodexSkillNames,
      planningOnly: true,
      workspaceDir: String(d.codexWorkspaceDir || '').trim(),
      model: String(d.codexModel || TIMELINE_CODEX_DEFAULT_MODEL).trim(),
      profile: String(d.codexProfile || '').trim(),
      sandbox: String(d.codexSandbox || 'workspace-write'),
      approvalPolicy: String(d.codexApprovalPolicy || 'never'),
      reasoningEffort: String(d.codexReasoningEffort || '').trim(),
      webSearch: d.codexWebSearch === true,
      includePlanTool: d.codexIncludePlanTool === true,
      executablePath: String(d.codexExecutablePath || '').trim(),
      extraArgs: parseExtraArgs(d.codexExtraArgs),
    }, { signal: options.signal });
    return String(result.text || result.reply || '').trim();
  };
  const saveTimelineAgentImageToResourceLibrary = async (url: string, title: string) => {
    try {
      await api.addResourceItem({
        kind: 'image',
        url,
        title,
        tags: ['Codex CLI', '时间轴导演', '关键帧'],
        sourceNodeId: id,
        favorite: false,
      });
      window.dispatchEvent(new CustomEvent('penguin:resources-changed'));
    } catch (resourceError: any) {
      logBus.warn(`关键帧已写回节点，资源库保存失败：${resourceError?.message || resourceError}`, src);
    }
  };

  const handleAgentStoryboard = async (options: { preludeText?: string; allowWhileExecuting?: boolean } = {}) => {
    if (agentExecuting && !options.allowWhileExecuting) return;
    if (!codexImageGenerationReady) {
      setError(codexKeyframeTitle);
      return;
    }
    if (!keyframeTextReady) {
      setError('先输入元脚本，才能文生图/图文生图');
      return;
    }
    const resolvedGlobalPromptNow = resolveMediaMentions(globalPrompt, globalPromptMentions, mentionMaterials).trim();
    const referenceImages = dedupe([...localRefImages, ...requestImages, ...codexTaskMentionedMedia.images]);
    const referenceVideos = dedupe([...requestVideos, ...codexTaskMentionedMedia.videos]);
    const referenceAudios = dedupe([...requestAudios, ...codexTaskMentionedMedia.audios]);
    const preludeText = String(options.preludeText || '').trim();
    const runToken = ++agentRunTokenRef.current;
    const runController = new AbortController();
    agentRunControllerRef.current = runController;
    const isActiveRun = () => agentRunTokenRef.current === runToken;
    const runLog = [`${new Date().toLocaleTimeString()} 开始：脚本快拆`];
    const addAgentLog = (message: string, extra: Record<string, any> = {}) => {
      if (!isActiveRun()) return;
      runLog.push(`${new Date().toLocaleTimeString()} ${message}`);
      const nextLog = runLog.slice(-80);
      const nextConversation = buildCodexConversation(codexAgentTaskPrompt, [preludeText, message].filter(Boolean).join('\n\n'), {
        modeLabel: '脚本快拆模式：真实链路执行中',
        logs: nextLog,
        planText: typeof extra.agentStoryboardPlanText === 'string' ? extra.agentStoryboardPlanText : agentStoryboardPlanText,
      });
      update({ agentStoryboardLog: nextLog, agentStoryboardMessage: message, agentMessage: nextConversation, ...extra });
      setAgentMessage(nextConversation);
    };
    setError(null);
    setAgentExecuting(true);
    const startConversation = buildCodexConversation(codexAgentTaskPrompt, [preludeText, 'Codex Agent 正在理解脚本和参考图...'].filter(Boolean).join('\n\n'), {
      modeLabel: '脚本快拆模式：真实链路执行中',
      logs: runLog,
    });
    setAgentMessage(startConversation);
    update({
      agentStoryboardStatus: 'running',
      agentStoryboardMessage: 'Codex Agent 正在理解脚本和参考图...',
      agentMessage: startConversation,
      agentStoryboardOutputCount: 0,
      agentStoryboardOutputUrls: [],
      agentStoryboardGridImageUrl: '',
      agentStoryboardPlanText: '',
      agentStoryboardLog: runLog,
    });
    try {
      const planPrompt = buildTimelineDirectorAgentPlanPrompt({
        script: resolvedCodexAgentTaskPrompt,
        globalPrompt: resolvedGlobalPromptNow,
        referenceImageCount: referenceImages.length,
        maxShots: MAX_IMAGES,
      });
      const planText = await callCodexAgent(planPrompt.system, planPrompt.user, {
        referenceImages,
        referenceVideos,
        referenceAudios,
        referenceTexts: [upstreamTextContext, resolvedCodexAgentTaskPrompt, resolvedGlobalPromptNow].filter(Boolean),
        signal: runController.signal,
      });
      if (!isActiveRun()) return;
      addAgentLog('LLM 已返回拆镜计划，正在解析 JSON...', { agentStoryboardPlanText: planText });
      const plan = normalizeTimelineDirectorAgentPlan(
        extractTimelineDirectorAgentPlanJson(planText),
        { fallbackGlobalPrompt: resolvedGlobalPromptNow, maxShots: MAX_IMAGES },
      );
      const layout = timelineStoryboardGridLayout(plan.shots.length);
      const exportIndexes = plan.shots.map((_, index) => index + 1);
      const gridAspectRatio = timelineGridAspectRatio(layout, ratio);
      addAgentLog(`已拆出 ${plan.shots.length} 个镜头，开始生成 ${layout.rows}x${layout.cols} 宫格图...`);

      const gridPrompt = [
        plan.globalPrompt,
        `生成一张 ${layout.rows} 行 ${layout.cols} 列的 story grid / contact sheet，总共 ${plan.shots.length} 个有效格子。`,
        '每个格子是一张独立关键帧图，清晰分隔，构图可直接裁切给即梦 Seedance 单视频时间轴使用。',
        '不要文字、编号、水印、UI、边框装饰；只保留画面内容。空余格子保持干净背景或延展环境，不要加入新镜头。',
        '默认 2K 质量。参考图作为真实图像输入使用，必须继承用户用 @图片名 定义的人物/场景身份。',
        ...plan.shots.map((shot, index) => [
          `格${index + 1} / 镜头名：${shot.imageName}`,
          shot.imagePrompt || shot.prompt,
        ].filter(Boolean).join('\n')),
      ].filter(Boolean).join('\n\n');

      const gridResult = await streamCodexImageConjure({
        nodeId: id,
        sessionId: codexSessionId,
        prompt: gridPrompt,
        images: referenceImages,
        selectedSkillNames: selectedCodexSkillNames,
        workspaceDir: String(d.codexWorkspaceDir || '').trim(),
        model: String(d.codexModel || TIMELINE_CODEX_DEFAULT_MODEL).trim(),
        profile: String(d.codexProfile || '').trim(),
        sandbox: String(d.codexSandbox || 'workspace-write'),
        approvalPolicy: String(d.codexApprovalPolicy || 'never'),
        reasoningEffort: String(d.codexReasoningEffort || '').trim(),
        webSearch: d.codexWebSearch === true,
        includePlanTool: d.codexIncludePlanTool === true,
        executablePath: String(d.codexExecutablePath || '').trim(),
        extraArgs: parseExtraArgs(d.codexExtraArgs),
        aspectRatio: gridAspectRatio,
        size: '2K',
        quality: '高',
        count: 1,
      }, {
        signal: runController.signal,
        onDelta: (delta) => {
          const text = String(delta || '').trim();
          if (text) addAgentLog(`生图：${text.slice(0, 120)}`);
        },
        onEvent: (event) => {
          if (event?.artifact?.kind === 'image') addAgentLog('image_generation 已返回宫格图产物');
        },
      });
      if (!isActiveRun()) return;
      const gridImageUrl = gridResult.imageUrls[0] || gridResult.imageUrl;
      if (!gridImageUrl) throw new Error('Codex 没有生成宫格图');
      addAgentLog('宫格图已生成，正在自动切分...', { agentStoryboardGridImageUrl: gridImageUrl });

      const cropResult = await opGridCrop(gridImageUrl, layout.rows, layout.cols, 0, undefined, { exportIndexes });
      if (!isActiveRun()) return;
      const generatedUrls = dedupe(cropResult.urls || []).slice(0, plan.shots.length);
      if (generatedUrls.length < plan.shots.length) throw new Error(`宫格切图数量不足：需要 ${plan.shots.length}，实际 ${generatedUrls.length}`);
      const nextBlocks: TimelineDirectorBlockInput[] = plan.shots.map((shot, index) => ({
          id: genId('agent-shot'),
          title: shot.title,
          imageName: shot.imageName,
          imageUrl: generatedUrls[index],
          prompt: shot.prompt,
          mentions: [],
          durationSec: shot.durationSec,
      }));
      generatedUrls.forEach((url, index) => {
        const shot = plan.shots[index];
        void saveTimelineAgentImageToResourceLibrary(url, shot?.title || shot?.imageName || `镜头${index + 1}`);
      });

      const normalizedBlocks = normalizeTimelineDirectorTotalDuration(nextBlocks, 0);
      const doneLog = [...runLog, `${new Date().toLocaleTimeString()} 完成：宫格图切出 ${generatedUrls.length} 张关键帧`].slice(-80);
      const doneConversation = buildCodexConversation(codexAgentTaskPrompt, [preludeText, `完成：宫格图已切出 ${generatedUrls.length} 张关键帧，并写回镜头`].filter(Boolean).join('\n\n'), {
        modeLabel: '脚本快拆模式：真实链路已完成',
        logs: doneLog,
        planText,
      });
      update({
        blocks: normalizedBlocks,
        globalPrompt: plan.globalPrompt || globalPrompt,
        globalPromptMentions: plan.globalPrompt ? [] : globalPromptMentions,
        localRefImages,
        agentStoryboardStatus: 'success',
        agentStoryboardMessage: `完成：宫格图已切出 ${generatedUrls.length} 张关键帧，并写回镜头`,
        agentStoryboardOutputCount: generatedUrls.length,
        agentStoryboardOutputUrls: generatedUrls,
        agentStoryboardGridImageUrl: gridImageUrl,
        agentStoryboardPlanText: planText,
        outputText: planText,
        text: planText,
        reply: planText,
        imageUrl: generatedUrls[0] || gridImageUrl,
        imageUrls: dedupe([gridImageUrl, ...generatedUrls]),
        agentStoryboardLog: doneLog,
        agentMessage: doneConversation,
        agentStoryboardLastRunAt: Date.now(),
      });
      setActiveId(normalizedBlocks[0]?.id || null);
      setAgentMessage(doneConversation);
      logBus.success(`Codex Agent 已写回 ${generatedUrls.length} 个时间轴镜头`, src);
    } catch (e: any) {
      if (!isActiveRun()) return;
      const message = e?.message || 'Codex Agent 拆镜生帧失败';
      setError(message);
      update({
        agentStoryboardStatus: 'error',
        agentStoryboardMessage: message,
        agentMessage: buildCodexConversation(codexAgentTaskPrompt, [preludeText, message].filter(Boolean).join('\n\n'), {
          modeLabel: '脚本快拆模式：真实链路失败',
          logs: runLog,
        }),
      });
      setAgentMessage(buildCodexConversation(codexAgentTaskPrompt, [preludeText, message].filter(Boolean).join('\n\n'), {
        modeLabel: '脚本快拆模式：真实链路失败',
        logs: runLog,
      }));
    } finally {
      if (isActiveRun()) {
        setAgentExecuting(false);
        agentRunControllerRef.current = null;
      }
    }
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
    () => dedupe(mentionedMedia.videos),
    [mentionedMedia.videos],
  );
  const requestAudios = useMemo(
    () => dedupe(mentionedMedia.audios),
    [mentionedMedia.audios],
  );
  const timelineImageUrls = useMemo(() => dedupe(blocks.map((block) => block.imageUrl)), [blocks]);
  const requestImages = useMemo(() => {
    const timelineSet = new Set(timelineImageUrls);
    return dedupe(mentionedMedia.images.filter((url) => !timelineSet.has(url)));
  }, [mentionedMedia.images, timelineImageUrls]);
  const codexTaskMentionedMedia = useMemo(
    () => collectMentionedMedia(codexAgentTaskPromptMentions, mentionMaterials),
    [codexAgentTaskPromptMentions, mentionMaterials],
  );
  const resolvedCodexAgentTaskPrompt = useMemo(
    () => resolveMediaMentions(codexAgentTaskPrompt, codexAgentTaskPromptMentions, mentionMaterials).trim(),
    [codexAgentTaskPrompt, codexAgentTaskPromptMentions, mentionMaterials],
  );
  const totalRequestImages = useMemo(() => dedupe([...requestImages, ...timelineImageUrls]).length, [requestImages, timelineImageUrls]);
  const totalValid = blocks.length >= 1 && imagedCount === blocks.length && totalDuration >= MIN_TOTAL && totalDuration <= MAX_TOTAL && totalRequestImages <= MAX_IMAGES;
  const compiledSegments = useMemo(() => buildTimelineDirectorSegments(resolvedBlocks), [resolvedBlocks]);
  const compiledPrompt = useMemo(
    () => buildTimelineDirectorCompiledPrompt(resolvedBlocks, { globalPrompt: resolvedGlobalPrompt }),
    [resolvedBlocks, resolvedGlobalPrompt],
  );
  const compiled = useMemo(() => ({
    prompt: compiledPrompt,
    transitionPrompts: compiledSegments.slice(0, Math.max(0, timelineImageUrls.length - 1)).map(() => compiledPrompt),
    transitionDurations: compiledSegments.slice(0, Math.max(0, timelineImageUrls.length - 1)).map((segment) => segment.durationSec),
    images: dedupe([...requestImages, ...timelineImageUrls]),
    referenceImages: requestImages,
    videos: requestVideos,
    audios: requestAudios,
  }), [compiledPrompt, compiledSegments, requestImages, requestVideos, requestAudios, timelineImageUrls]);

  const buildCodexConversation = (
    userPrompt: string,
    codexText: string,
    options: { modeLabel?: string; logs?: string[]; planText?: string } = {},
  ) => [
    'USER',
    userPrompt || '(空任务)',
    '',
    'CODEX',
    options.modeLabel || '',
    codexText || '',
    options.logs?.length ? options.logs.join('\n') : '',
    options.planText ? `\n拆镜计划\n${options.planText}` : '',
  ].filter(Boolean).join('\n');

  const handleCodexStudioRun = async (runMode: CodexStudioRunMode = 'normal') => {
    if (agentExecuting) return;
    if (!codexCliReady) {
      setError(codexStatus?.message || 'Codex CLI 不可用');
      return;
    }
    const userPrompt = String(resolvedCodexAgentTaskPrompt || codexAgentTaskPrompt || '').trim();
    if (!userPrompt) {
      setError('先输入任务');
      return;
    }
    const referenceImages = dedupe([...localRefImages, ...requestImages, ...codexTaskMentionedMedia.images]);
    const referenceVideos = dedupe([...requestVideos, ...codexTaskMentionedMedia.videos]);
    const referenceAudios = dedupe([...requestAudios, ...codexTaskMentionedMedia.audios]);
    let streamedText = '';
    const artifactImageUrls: string[] = [];
    const isStoryboardQuickSplit = runMode === 'storyboardQuickSplit';
    const modeLabel = isStoryboardQuickSplit ? '脚本快拆模式：先理解脚本和参考图，再生成 2K 宫格关键帧并写回镜头。' : '';
    const startMessage = buildCodexConversation(userPrompt, 'Codex Agent 正在执行任务...', { modeLabel });
    setError(null);
    const runToken = ++agentRunTokenRef.current;
    const runController = new AbortController();
    agentRunControllerRef.current = runController;
    const isActiveRun = () => agentRunTokenRef.current === runToken;
    setAgentExecuting(true);
    setAgentMessage(startMessage);
    update({ agentMessage: startMessage, status: 'running' });
    try {
      const result = await streamCodexCliAgent({
        nodeId: id,
        sessionId: codexSessionId,
        mode: 'chat',
        command: '/chat',
        preset: '时间轴导演台',
        prompt: [
          '你是时间轴导演台内嵌的 Codex CLI Agent 通用创作工作台。',
          '你可以根据用户任务分析脚本、参考图、素材、提示词、视频方案或产出文本方案。',
          isStoryboardQuickSplit
            ? '本轮为脚本快拆模式。请先输出拆镜思路、镜头数建议、每镜头时长建议、关键帧生成要点；随后系统会继续调用时间轴导演台真实快拆链路：LLM 拆镜 JSON -> image2 生成 2K 宫格图 -> 自动切图 -> 写回每个镜头。'
            : '不要默认改写时间轴镜头。只有用户明确要求，才输出可供脚本快拆使用的镜头建议；实际自动写回镜头和关键帧由“脚本快拆”同级执行模式完成。',
          upstreamTextContext ? `上游文本素材：\n${upstreamTextContext}` : '',
          resolvedGlobalPrompt ? `当前全局提示词：\n${resolvedGlobalPrompt}` : '',
          compiledPrompt ? `当前时间轴发送 Prompt：\n${compiledPrompt}` : '',
          userPrompt,
        ].filter(Boolean).join('\n\n'),
        referenceTexts: [upstreamTextContext, userPrompt, resolvedGlobalPrompt, compiledPrompt].filter(Boolean),
        images: referenceImages,
        videos: referenceVideos,
        audios: referenceAudios,
        selectedSkillNames: selectedCodexSkillNames,
        workspaceDir: String(d.codexWorkspaceDir || '').trim(),
        model: String(d.codexModel || TIMELINE_CODEX_DEFAULT_MODEL).trim(),
        profile: String(d.codexProfile || '').trim(),
        sandbox: String(d.codexSandbox || 'workspace-write'),
        approvalPolicy: String(d.codexApprovalPolicy || 'never'),
        reasoningEffort: String(d.codexReasoningEffort || '').trim(),
        webSearch: d.codexWebSearch === true,
        includePlanTool: d.codexIncludePlanTool === true,
        executablePath: String(d.codexExecutablePath || '').trim(),
        extraArgs: parseExtraArgs(d.codexExtraArgs),
      }, {
        signal: runController.signal,
        onDelta: (delta) => {
          if (!isActiveRun()) return;
          streamedText += delta;
          const nextMessage = buildCodexConversation(userPrompt, streamedText || 'Codex Agent 正在执行任务...', { modeLabel });
          setAgentMessage(nextMessage);
          update({ agentMessage: nextMessage });
        },
        onEvent: (event) => {
          if (!isActiveRun()) return;
          const artifact = event?.artifact;
          if (artifact?.kind === 'image') artifactImageUrls.push(...dedupe([artifact.url || '', ...(Array.isArray(artifact.urls) ? artifact.urls : [])]));
        },
      });
      if (!isActiveRun()) return;
      const artifactUrls = Array.isArray(result.artifacts)
        ? result.artifacts.flatMap((artifact: any) => artifact?.kind === 'image' ? [artifact.url || '', ...(Array.isArray(artifact.urls) ? artifact.urls : [])] : [])
        : [];
      const imageUrls = dedupe([result.imageUrl || '', ...(Array.isArray(result.imageUrls) ? result.imageUrls : []), ...artifactImageUrls, ...artifactUrls]);
      const finalText = String(result.text || result.reply || streamedText || '').trim();
      const finalMessage = buildCodexConversation(userPrompt, finalText || 'Codex Agent 已完成任务', { modeLabel });
      update({
        status: 'success',
        error: '',
        agentMessage: finalMessage,
        outputText: finalText,
        text: finalText,
        reply: finalText,
        imageUrl: imageUrls[0] || d.imageUrl || '',
        imageUrls: imageUrls.length ? imageUrls : d.imageUrls,
        codexLastRunAt: Date.now(),
      });
      setAgentMessage(finalMessage);
      if (isStoryboardQuickSplit) {
        await handleAgentStoryboard({ preludeText: finalText, allowWhileExecuting: true });
        return;
      }
      logBus.success('时间轴导演台 Codex Agent 任务完成', src);
      taskCompletionSound.notifyComplete(id, 'codex-cli-agent');
    } catch (e: any) {
      if (!isActiveRun()) return;
      const message = e?.message || 'Codex Agent 运行失败';
      setError(message);
      const nextMessage = buildCodexConversation(userPrompt, message, { modeLabel });
      update({ status: 'error', error: message, agentMessage: nextMessage });
      setAgentMessage(nextMessage);
    } finally {
      if (isActiveRun()) {
        setAgentExecuting(false);
        agentRunControllerRef.current = null;
      }
    }
  };

  // === 生成 ===
  const startTimer = () => { setElapsed(0); if (elapsedTimer.current) window.clearInterval(elapsedTimer.current); elapsedTimer.current = window.setInterval(() => setElapsed((e) => e + 1), 1000) as unknown as number; };
  const stopTimer = () => { if (elapsedTimer.current) { window.clearInterval(elapsedTimer.current); elapsedTimer.current = null; } };
  useEffect(() => () => { stopTimer(); cancelActiveAgentRun(); }, []);

  const handleGenerate = async () => {
    setError(null);
    if (!activeJimeng) { setError('未配置即梦 CLI 平台(API 设置 → 高级供应商)'); return; }
    if (blocks.length < 1) { setError('至少需要 1 个镜头'); return; }
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
  const codexFeatureNames = useMemo(() => {
    const names = [
      ...(Array.isArray(codexStatus?.featureNames) ? codexStatus.featureNames : []),
      ...(Array.isArray(codexStatus?.features) ? codexStatus.features.map((feature) => feature?.name) : []),
    ];
    return new Set(names.map((name) => String(name || '').trim()).filter(Boolean));
  }, [codexStatus]);
  const keyframeTextReady = !!String(codexAgentTaskPrompt || '').trim();
  const codexCliReady = codexStatus?.available === true;
  const codexImageGenerationReady = codexCliReady && codexFeatureNames.has('image_generation');
  const codexKeyframeDisabled = agentExecuting || codexStatusLoading || !codexImageGenerationReady;
  const codexKeyframeTitle = codexStatusLoading
    ? '正在检测 Codex CLI'
    : !codexCliReady
      ? (codexStatus?.message || 'Codex CLI 不可用')
      : !codexImageGenerationReady
        ? '当前 Codex CLI 未提供 image_generation，不能直接生成关键帧'
        : '打开文生图/图文生图关键帧工作台';
  const nodeReferenceItems = useMemo(() => [
    ...localRefImages.map((url) => ({ kind: 'image' as const, url })),
    ...localRefVideos.map((url) => ({ kind: 'video' as const, url })),
    ...localRefAudios.map((url) => ({ kind: 'audio' as const, url })),
  ], [localRefImages, localRefVideos, localRefAudios]);
  const codexInputPreviewItems = useMemo(() => {
    const textItems = upstream.texts.map((item, index) => ({
      kind: 'text' as const,
      url: item.url,
      label: item.label || `上游文本${index + 1}`,
    }));
    const imageItems = dedupe([...localRefImages, ...requestImages, ...codexTaskMentionedMedia.images]).map((url, index) => ({
      kind: 'image' as const,
      url,
      label: fileName(url) || `参考图${index + 1}`,
    }));
    const videoItems = dedupe([...requestVideos, ...codexTaskMentionedMedia.videos]).map((url, index) => ({
      kind: 'video' as const,
      url,
      label: fileName(url) || `参考视频${index + 1}`,
    }));
    const audioItems = dedupe([...requestAudios, ...codexTaskMentionedMedia.audios]).map((url, index) => ({
      kind: 'audio' as const,
      url,
      label: fileName(url) || `参考音频${index + 1}`,
    }));
    return [...textItems, ...imageItems, ...videoItems, ...audioItems];
  }, [codexTaskMentionedMedia.audios, codexTaskMentionedMedia.images, codexTaskMentionedMedia.videos, localRefImages, requestAudios, requestImages, requestVideos, upstream.texts]);
  const removeRef = (kind: ReferenceKind, url: string) => {
    if (kind === 'image') {
      update({ localRefImages: localRefImages.filter((item) => item !== url) });
      return;
    }
    if (kind === 'video') {
      update({ localRefVideos: localRefVideos.filter((item) => item !== url) });
      return;
    }
    update({ localRefAudios: localRefAudios.filter((item) => item !== url) });
  };
  const refreshOutputs = () => {
    const urls = completedVideoUrls.length ? completedVideoUrls : (videoUrl ? [videoUrl] : []);
    if (urls.length) update({ videoUrl: urls[0], videoUrls: urls });
  };
  const cardCls = `rounded-xl border p-2.5 ${isPixel ? 'px-card' : ''}`;
  const btnCls = 'nodrag flex h-8 items-center justify-center gap-1 rounded-lg border px-2 py-1 text-[11px] leading-none';
  const controlCls = 'nodrag h-8 rounded-lg border px-2 py-1 text-[11px] leading-normal outline-none';
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
  const renderReferencePool = () => {
    if (nodeReferenceItems.length === 0) {
      return <div className="text-[10px]" style={mutedStyle}>暂无节点素材</div>;
    }
    return (
      <div className="flex flex-wrap gap-1.5" data-timeline-reference-pool>
        {nodeReferenceItems.map((ref, index) => (
          <div
            key={`${ref.kind}:${ref.url}`}
            className="group relative nodrag nopan"
            title={ref.kind === 'image' ? '点击设为当前镜头图片；输入 @ 可引用' : '输入 @ 可引用'}
          >
            {ref.kind === 'image' ? (
              <div className="relative">
                <button
                  type="button"
                  className="block overflow-hidden rounded border bg-black/35"
                  style={{ borderColor: activeBlock?.imageUrl === ref.url ? 'var(--t8-accent, #d946ef)' : 'var(--t8-border-strong, rgba(255,255,255,.18))' }}
                  onClick={() => setActiveImage(ref.url, fileName(ref.url))}
                  onDoubleClick={(event) => {
                    event.stopPropagation();
                    setPreviewImageUrl(ref.url);
                  }}
                  title="点击设为当前镜头图片；双击预览大图"
                >
                  <SmartImage src={ref.url} alt="" thumbSize={180} className="h-12 w-14 object-cover" />
                </button>
                <button
                  type="button"
                  className="absolute bottom-0.5 right-0.5 flex h-5 w-5 items-center justify-center rounded border bg-black/65 text-white"
                  style={{ borderColor: 'rgba(255,255,255,.22)' }}
                  onClick={(event) => {
                    event.stopPropagation();
                    setPreviewImageUrl(ref.url);
                  }}
                  title="预览大图"
                  aria-label="预览大图"
                >
                  <Eye size={11} />
                </button>
                <div
                  className="pointer-events-none absolute left-[calc(100%+6px)] top-0 z-[80] hidden w-44 rounded-lg border bg-black/90 p-1 shadow-2xl group-hover:block"
                  style={{ borderColor: 'rgba(255,255,255,.22)' }}
                >
                  <SmartImage src={ref.url} alt="" thumbSize={360} className="h-28 w-full rounded object-contain" />
                  <div className="mt-1 truncate px-1 text-[9px] text-white/75">{fileName(ref.url)}</div>
                </div>
              </div>
            ) : ref.kind === 'video' ? (
              <LoopingVideo
                src={ref.url}
                className="h-12 w-14 rounded object-cover border bg-black"
                style={{ borderColor: 'var(--t8-border-strong, rgba(255,255,255,.18))' }}
                muted
              />
            ) : (
              <div
                className="h-12 w-14 rounded border flex flex-col items-center justify-center text-[9px]"
                style={{ borderColor: 'var(--t8-border-strong, rgba(255,255,255,.18))', background: 'var(--t8-bg-panel, rgba(15,23,42,.72))' }}
              >
                <Music size={14} />
                <span className="max-w-full truncate px-1">{fileName(ref.url)}</span>
              </div>
            )}
            <span
              className="pointer-events-none absolute left-0.5 top-0.5 rounded px-1 text-[8px] font-semibold"
              style={{ background: 'rgba(0,0,0,.55)', color: '#fff' }}
            >
              {ref.kind === 'image' ? `图${index + 1}` : ref.kind === 'video' ? '视' : '音'}
            </span>
            <button
              type="button"
              className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-rose-500 text-white"
              onClick={(event) => {
                event.stopPropagation();
                removeRef(ref.kind, ref.url);
              }}
              title="移除素材"
            >
              <X size={9} />
            </button>
          </div>
        ))}
      </div>
    );
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
  const keyframeStudio = (keyframeStudioOpen || codexStudioOpen) && typeof document !== 'undefined' ? createPortal(
    <div className="fixed inset-0 z-[9998] nodrag nopan bg-black/55" onMouseDown={(event) => event.stopPropagation()}>
      <div
        className="absolute inset-4 flex flex-col overflow-hidden rounded-2xl border-2 shadow-2xl"
        style={{ background: '#f4ead6', borderColor: '#111827', color: '#1f2933', boxShadow: '6px 6px 0 rgba(0,0,0,.86)' }}
      >
        <div className="flex items-center justify-between border-b-2 px-5 py-4" style={{ borderColor: '#111827', background: 'linear-gradient(180deg, #ffe58f, #f7d66f)', color: '#111827' }}>
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border-2 bg-yellow-100" style={{ borderColor: '#111827' }}>
              <TerminalSquare size={20} />
            </div>
            <div className="min-w-0">
              <div className="truncate text-lg font-black">Codex 创作台</div>
              <div className="truncate text-xs font-semibold text-black/55">流式对话 · Skill 调用 · 产物库 · 脚本快拆</div>
            </div>
          </div>
          <button type="button" className="nodrag flex h-9 w-9 items-center justify-center rounded-lg border-2 bg-white/45" style={{ borderColor: '#111827' }} onClick={() => { setKeyframeStudioOpen(false); setCodexStudioOpen(false); }} title="关闭">
            <X size={18} />
          </button>
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-[270px_minmax(560px,1fr)_305px] overflow-hidden">
          <aside className="min-h-0 overflow-y-auto border-r-2 p-4" style={{ borderColor: '#111827', background: '#f0e5cf' }}>
            <div className="mb-3 flex items-center justify-between gap-2">
              <div>
                <div className="text-sm font-black">创作工作区</div>
                <div className="text-[11px] font-semibold text-black/55">会话 · 项目 · 模板 · Skill · 参数</div>
              </div>
              <button
                type="button"
                className="nodrag rounded-md border px-2 py-1 text-[11px] font-black"
                style={{ borderColor: '#111827', background: '#fff8e8' }}
                onClick={() => {
                  void refreshCodexStatus();
                  setCodexSkillLoading(true);
                  void getCodexCliSkills({
                    nodeId: id,
                    sessionId: codexSessionId,
                    workspaceDir: String(d.codexWorkspaceDir || '').trim(),
                  }).then((result) => {
                    setCodexSkills(Array.isArray(result.skills) ? result.skills : []);
                    if (result.workspaceDir) update({ codexWorkspaceDir: result.workspaceDir });
                  }).finally(() => setCodexSkillLoading(false));
                }}
              >
                刷新
              </button>
            </div>

            <section className="mb-4 rounded-xl border-2 p-3" style={{ borderColor: '#111827', background: '#f6eddc' }}>
              <div className="mb-2 flex items-center justify-between gap-2">
                <div>
                  <div className="text-sm font-black">会话列表</div>
                  <div className="text-[11px] font-semibold text-black/55">项目内多轮创作对话</div>
                </div>
                <button
                  type="button"
                  data-timeline-new-codex-session="true"
                  className="nodrag inline-flex h-8 items-center gap-1 rounded-lg border-2 px-2 text-[11px] font-black"
                  style={{ borderColor: '#111827', background: '#fffdf6' }}
                  onPointerDownCapture={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                  }}
                  onMouseDownCapture={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                  }}
                  onClickCapture={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    startNewTimelineSession();
                  }}
                  title="创建新的 Codex 后端会话"
                >
                  <Plus size={13} /> 新建会话
                </button>
              </div>
              <div className="space-y-1.5">
                {[{
                  id: codexSessionId,
                  title: String(d.codexTimelineSessionTitle || '当前会话'),
                  updatedAt: Date.now(),
                  messageCount: agentStoryboardLog.length,
                  artifactCount: agentStoryboardOutputUrls.length + (agentStoryboardGridImageUrl ? 1 : 0) + (agentStoryboardPlanText ? 1 : 0),
                  snapshot: currentTimelineSessionSnapshot(),
                }, ...codexTimelineSessions.filter((session: any) => session.id !== codexSessionId)].slice(0, 5).map((session: any) => {
                  const activeSession = session.id === codexSessionId;
                  return (
                    <button
                      key={session.id}
                      type="button"
                      className="nodrag w-full rounded-lg border-2 px-3 py-2 text-left text-xs font-black"
                      style={{ borderColor: '#111827', background: activeSession ? '#ffe28a' : '#fffdf6' }}
                      onClick={() => {
                        if (!activeSession) restoreTimelineSession(session);
                      }}
                      title={activeSession ? '当前 Codex 后端会话' : '切换到这个 Codex 后端会话'}
                    >
                      {session.title || '当前会话'}
                      <div className="mt-0.5 text-[10px] font-semibold text-black/55">
                        {session.messageCount || 0} 条对话 · {session.artifactCount || 0} 个产物 · {String(session.id).slice(-6)}
                      </div>
                    </button>
                  );
                })}
              </div>
            </section>

            <section className="mb-4 rounded-xl border-2 p-3" style={{ borderColor: '#111827', background: '#f6eddc' }}>
              <div className="mb-2 text-sm font-black">项目管理</div>
              <div className="space-y-1 text-[11px] font-semibold text-black/55">
                <div className="flex justify-between"><span>工作区</span><span>{String(d.codexWorkspaceDir || '').trim() ? '已创建' : '待创建'}</span></div>
                <div className="flex justify-between"><span>当前模型</span><span>{String(d.codexModel || TIMELINE_CODEX_DEFAULT_MODEL)}</span></div>
                <div className="flex justify-between"><span>已选 Skill</span><span>{selectedCodexSkillNames.length}</span></div>
                <div className="flex justify-between"><span>@ 产物</span><span>{agentMaterials.length}</span></div>
                <div className="flex justify-between"><span>记忆条数</span><span>{Number(d.codexContextLimit || TIMELINE_CODEX_CONTEXT_DEFAULT_LIMIT)} / {TIMELINE_CODEX_CONTEXT_MAX_LIMIT}</span></div>
              </div>
              <label className="mt-3 grid gap-1 text-[11px] font-black text-black/60">
                创作台记忆
                <input
                  className="nodrag w-full rounded-lg border-2 px-2 py-1.5 text-xs outline-none"
                  style={{ borderColor: '#111827', background: '#fffdf6', color: '#111827' }}
                  type="number"
                  min={0}
                  max={TIMELINE_CODEX_CONTEXT_MAX_LIMIT}
                  step={1}
                  value={Number(d.codexContextLimit || TIMELINE_CODEX_CONTEXT_DEFAULT_LIMIT)}
                  onChange={(event) => {
                    const nextLimit = clamp(Number(event.currentTarget.value) || TIMELINE_CODEX_CONTEXT_DEFAULT_LIMIT, 0, TIMELINE_CODEX_CONTEXT_MAX_LIMIT);
                    update({ codexContextLimit: nextLimit });
                  }}
                />
              </label>
              <div className="mt-2 rounded-lg border-2 px-2 py-1.5 text-[10px] leading-relaxed text-black/55" style={{ borderColor: '#111827', background: '#fffdf6' }}>
                超出条数的旧对话会按当前会话存档；新建会话会清空当前上下文。
              </div>
              <button
                type="button"
                className="nodrag mt-3 w-full rounded-lg border-2 px-3 py-2 text-xs font-black"
                style={{ borderColor: '#111827', background: '#fff8e8' }}
                onClick={() => {
                  void refreshCodexStatus();
                  setCodexSkillLoading(true);
                  void getCodexCliSkills({
                    nodeId: id,
                    sessionId: codexSessionId,
                    workspaceDir: String(d.codexWorkspaceDir || '').trim(),
                  }).then((result) => {
                    setCodexSkills(Array.isArray(result.skills) ? result.skills : []);
                    if (result.workspaceDir) update({ codexWorkspaceDir: result.workspaceDir });
                  }).finally(() => setCodexSkillLoading(false));
                }}
              >
                刷新项目状态
              </button>
              <input
                className="nodrag mt-2 w-full rounded-lg border-2 px-2 py-1.5 text-[11px] outline-none"
                style={{ borderColor: '#111827', background: '#fffdf6', color: '#111827' }}
                value={String(d.codexWorkspaceDir || '')}
                placeholder="/home/chris/.config/t8-penguin-canvas/..."
                onChange={(event) => update({ codexWorkspaceDir: event.currentTarget.value })}
              />
              <div className="mt-2 grid grid-cols-2 gap-2">
                <button type="button" className="nodrag rounded-lg border-2 px-2 py-1.5 text-[11px] font-black" style={{ borderColor: '#111827', background: '#fffdf6' }} onClick={createNewTimelineWorkspace}>
                  新建工作区
                </button>
                <button type="button" className="nodrag rounded-lg border-2 px-2 py-1.5 text-[11px] font-black" style={{ borderColor: '#111827', background: '#fffdf6' }} onClick={archiveTimelineSessions}>
                  归档旧会话
                </button>
              </div>
            </section>

            <section className="mb-4 rounded-xl border-2 p-3" style={{ borderColor: '#111827', background: '#f6eddc' }}>
              <div className="mb-2 flex items-center justify-between gap-2">
                <div>
                  <div className="text-sm font-black">输入素材</div>
                  <div className="text-[11px] font-semibold text-black/55">当前会传给 Codex 的上游素材</div>
                </div>
                <span className="rounded-md border px-1.5 py-0.5 text-[10px] font-black" style={{ borderColor: '#111827', background: '#fffdf6' }}>
                  {inputMaterialTotal} 项
                </span>
              </div>
              <MaterialPreviewSection
                texts={orderedInputTexts}
                images={orderedInputImages}
                videos={orderedInputVideos}
                audios={orderedInputAudios}
                order={materialOrder}
                onReorder={setMaterialOrder}
                onExcludeUpstream={excludeUpstreamMaterial}
                excludedCount={excludedUpstreamCount}
                onRestoreExcluded={restoreExcludedMaterials}
                selected={!!selected}
                isDark={false}
                isPixel={isPixel}
                title="上游素材 · Agent 输入"
              />
              {inputMaterialTotal === 0 && excludedUpstreamCount === 0 && (
                <div className="mt-2 text-[11px] leading-relaxed text-black/55">
                  可从左侧连接文本、图片、视频或音频；连接后这里会显示缩略图，并可拖动排序或点 X 排除。
                </div>
              )}
            </section>

            <section className="mb-4 rounded-xl border-2 p-3" style={{ borderColor: '#111827', background: '#f6eddc' }}>
              <div className="mb-2 text-sm font-black">创作设置</div>
              <div className="mb-2 text-[11px] font-semibold text-black/55">Skill · 模型 · 后端参数</div>
              <label className="mb-2 grid gap-1 text-[11px] font-semibold text-black/55">
                Skill 列表
                <button
                  type="button"
                  data-timeline-codex-skill-trigger="true"
                  className="nodrag flex h-8 w-full min-w-0 items-center justify-between rounded-lg border-2 px-2 text-left text-[11px] font-black"
                  style={{ borderColor: '#111827', background: selectedCodexSkillNames.length ? '#5ccbc2' : '#fffdf6' }}
                  onClick={(event) => openSkillPicker(event.currentTarget, skillSearchQuery)}
                >
                  <span className="truncate">{codexSkillLoading ? '读取 Skill...' : selectedCodexSkillNames.length ? `已选 ${selectedCodexSkillNames.length} 个 Skill` : '选择 / 取消 Skill...'}</span>
                  <span className="text-[10px] text-black/55">{codexSkills.length}</span>
                </button>
              </label>
              <div className="mb-2 truncate rounded-lg border-2 px-2 py-1.5 text-[11px] leading-snug" style={{ borderColor: '#111827', background: '#fffdf6', color: '#111827' }}>
                {selectedCodexSkillNames.length ? `已选 ${selectedCodexSkillNames.length} 个：${selectedCodexSkillNames.slice(0, 3).map((name: string) => `$${name}`).join('、')}${selectedCodexSkillNames.length > 3 ? '...' : ''}` : '未选择 Skill；点上方下拉挂载真实 Skill。'}
              </div>
              <label className="mb-2 grid gap-1 text-[11px] font-semibold text-black/55">
                模型
                <select className="nodrag h-8 rounded-lg border-2 px-2 text-xs outline-none" style={{ borderColor: '#111827', background: '#fffdf6' }} value={String(d.codexModel || TIMELINE_CODEX_DEFAULT_MODEL)} onChange={(event) => update({ codexModel: event.currentTarget.value })}>
                  {CODEX_MODEL_OPTIONS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                </select>
              </label>
              <label className="nodrag mb-2 flex items-center gap-2 text-xs font-semibold text-black/60">
                <input type="checkbox" checked={d.codexWebSearch === true} onChange={(event) => update({ codexWebSearch: event.currentTarget.checked })} />
                Web Search
              </label>
              <label className="nodrag flex items-center gap-2 text-xs font-semibold text-black/60">
                <input type="checkbox" checked={d.codexIncludePlanTool === true} onChange={(event) => update({ codexIncludePlanTool: event.currentTarget.checked })} />
                Plan Tool
              </label>
            </section>

            <section className="rounded-xl border-2 p-3" style={{ borderColor: '#111827', background: '#f6eddc' }}>
              <div className="mb-2 text-sm font-black">工作台工具</div>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  className="nodrag rounded-lg border-2 px-2 py-2 text-xs font-black disabled:opacity-50"
                  style={{ borderColor: '#111827', background: '#fffdf6' }}
                  disabled={agentExecuting || !codexImageGenerationReady || !keyframeTextReady}
                  onClick={() => void handleCodexStudioRun('storyboardQuickSplit')}
                  title={codexKeyframeTitle}
                >
                  脚本快拆
                </button>
                <button
                  type="button"
                  data-timeline-codex-skill-trigger="true"
                  className="nodrag rounded-lg border-2 px-2 py-2 text-xs font-black disabled:opacity-50"
                  style={{ borderColor: '#111827', background: '#fffdf6' }}
                  disabled={codexSkillLoading || codexSkills.length === 0}
                  onClick={(event) => openSkillPicker(event.currentTarget, skillSearchQuery)}
                  title="打开真实 Codex Skill 列表"
                >
                  项目 Skill
                </button>
              </div>
            </section>

          </aside>

          <main className="flex min-h-0 flex-col bg-white text-slate-900">
            <div className="border-b-2 px-4 py-3" style={{ borderColor: '#111827', background: '#f6eddc' }}>
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate text-sm font-black">流式对话</div>
                  <div className="truncate text-[11px] font-semibold text-black/50">{String(d.codexModel || TIMELINE_CODEX_DEFAULT_MODEL)} · {selectedCodexSkillNames.length} 个 Skill · @ {agentStoryboardOutputUrls.length + (agentStoryboardGridImageUrl ? 1 : 0)} 个产物</div>
                </div>
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-5">
              <div className="space-y-8">
                {d.agentMessage || agentMessage || d.agentStoryboardMessage ? (
                  <div>
                    <div className="mb-1 flex items-center gap-2 text-[10px] font-black text-slate-500">
                      <span>流式对话</span>
                      <button type="button" className="nodrag rounded border px-1 py-0.5" style={{ borderColor: '#cbd5e1' }} onClick={() => void navigator.clipboard?.writeText?.(String(d.agentMessage || agentMessage || d.agentStoryboardMessage || ''))}>
                        <Copy size={10} />
                      </button>
                    </div>
                    <div className="whitespace-pre-wrap text-sm leading-relaxed">{String(d.agentMessage || agentMessage || d.agentStoryboardMessage || '')}</div>
                  </div>
                ) : (
                  <div className="py-4 text-sm leading-relaxed text-slate-500">
                    用 Codex 作为画布里的创作副驾驶：让它帮你拆图像方案、写提示词、做分镜，或者检查一组素材的创作风险。
                  </div>
                )}
                {agentStoryboardLog.map((line: string, index: number) => (
                  <div key={`${line}:${index}`} className="text-[11px] text-slate-500">{line}</div>
                ))}
                {agentStoryboardPlanText && (
                  <div className="rounded-lg border p-3" style={{ borderColor: '#d1d5db', background: '#f8fafc' }}>
                    <div className="mb-1 text-xs font-black">拆镜计划</div>
                    <pre className="max-h-56 overflow-y-auto whitespace-pre-wrap break-words text-xs text-slate-700">{agentStoryboardPlanText}</pre>
                  </div>
                )}
              </div>
            </div>

            <div className="border-t-2 p-4" style={{ borderColor: '#111827', background: '#fffdf6' }}>
              <div className="mb-2 flex items-center justify-between gap-2">
                <div>
                  <div className="text-sm font-black">输入任务</div>
                  <div className="text-[11px] font-semibold text-black/50">支持 @ 引用素材；Skill 通过左侧挂载；脚本快拆会拼入预置参数执行</div>
                </div>
              </div>
              <div className="rounded-xl border-2 p-2" style={{ borderColor: '#111827', background: '#fffdf6' }}>
                <MentionPromptInput
                  className="rounded-lg px-2 py-2 text-sm outline-none"
                  value={codexAgentTaskPrompt}
                  mentions={codexAgentTaskPromptMentions}
                  materials={mentionMaterials}
                  placeholder="输入创作任务；可用 @ 引用素材，或点左侧挂载 Skill..."
                  onChange={(value, mentions) => update({ codexAgentTaskPrompt: value, codexAgentTaskPromptMentions: mentions })}
                  onSubmit={() => void handleCodexStudioRun()}
                  isDark={false}
                  isPixel={isPixel}
                  expandable
                  promptTemplateKind="image"
                  title="Codex 流式对话"
                  style={{ color: '#111827', background: 'transparent', minHeight: 128, height: 128 }}
                />
              </div>
              <div className="mt-3 flex items-center justify-between gap-2">
                <div className="text-[11px] font-semibold text-black/50">刷新只检查 Codex CLI / Skill 状态；发送和脚本快拆都会进入上方流式对话。</div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    className="nodrag inline-flex items-center gap-1 rounded-lg border-2 px-3 py-2 text-sm font-black"
                    style={{ borderColor: '#111827', background: '#fff8e8' }}
                    onClick={() => void refreshCodexStatus()}
                  >
                    <RefreshCw size={15} /> 刷新
                  </button>
                  <button
                    type="button"
                    className="nodrag inline-flex items-center gap-1 rounded-lg border-2 px-4 py-2 text-sm font-black disabled:opacity-50"
                    style={{ borderColor: '#111827', background: '#ffe28a' }}
                    disabled={agentExecuting || !codexImageGenerationReady || !keyframeTextReady}
                    onClick={() => void handleCodexStudioRun('storyboardQuickSplit')}
                    title={codexKeyframeTitle}
                  >
                    {agentExecuting ? <Loader2 size={15} className="animate-spin" /> : <ImageIcon size={15} />} 脚本快拆
                  </button>
                  <button
                    type="button"
                    className="nodrag inline-flex items-center gap-1 rounded-lg border-2 px-4 py-2 text-sm font-black disabled:opacity-50"
                    style={{ borderColor: '#111827', background: '#fff8e8' }}
                    disabled={agentExecuting || !codexCliReady || !keyframeTextReady}
                    onClick={() => void handleCodexStudioRun()}
                  >
                    {agentExecuting ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />} 发送
                  </button>
                </div>
              </div>
            </div>
          </main>

          <aside className="min-h-0 overflow-y-auto border-l-2 p-4" style={{ borderColor: '#111827', background: '#f0e5cf' }}>
            <section className="mb-4 rounded-xl border-2 p-3" style={{ borderColor: '#111827', background: '#f6eddc' }}>
              <div className="mb-2 flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-sm font-black"><Library size={15} /> 产物库</div>
                <span className="rounded-md border px-1.5 py-0.5 text-[10px] font-black" style={{ borderColor: '#111827', background: '#fffdf6' }}>
                  图像 {agentStoryboardOutputUrls.length + (agentStoryboardGridImageUrl ? 1 : 0)} · 文本 {agentStoryboardPlanText ? 1 : 0}
                </span>
              </div>
              {agentStoryboardGridImageUrl ? (
                <button type="button" className="nodrag mb-2 w-full overflow-hidden rounded-lg border bg-black/10 p-1" style={{ borderColor: '#111827' }} onClick={() => setPreviewImageUrl(agentStoryboardGridImageUrl)}>
                  <SmartImage src={agentStoryboardGridImageUrl} alt="宫格图" thumbSize={360} className="h-28 w-full object-contain" />
                </button>
              ) : (
                <div className="text-xs text-black/50">暂无图像产物</div>
              )}
              {agentStoryboardOutputUrls.length > 0 && (
                <div className="mt-2 grid grid-cols-3 gap-1">
                  {agentStoryboardOutputUrls.map((url, index) => (
                    <button key={`${url}:${index}`} type="button" className="nodrag relative h-16 overflow-hidden rounded border bg-black/10" style={{ borderColor: '#111827' }} onClick={() => setPreviewImageUrl(url)}>
                      <SmartImage src={url} alt="" thumbSize={120} className="h-full w-full object-cover" />
                      <span className="absolute left-1 top-1 rounded bg-black/60 px-1 text-[8px] text-white">镜头{index + 1}</span>
                    </button>
                  ))}
                </div>
              )}
            </section>

            {agentStoryboardPlanText && (
              <section className="rounded-xl border-2 p-3" style={{ borderColor: '#111827', background: '#f6eddc' }}>
                <div className="mb-2 text-sm font-black">文本产物</div>
                <pre className="max-h-60 overflow-y-auto whitespace-pre-wrap break-words rounded-lg border-2 p-2 text-[11px]" style={{ borderColor: '#111827', background: '#fffdf6' }}>
                  {agentStoryboardPlanText}
                </pre>
              </section>
            )}
          </aside>
        </div>
      </div>
    </div>,
    document.body,
  ) : null;

  const skillPickerPortal = skillPickerOpen && codexSkills.length > 0 && typeof document !== 'undefined' ? createPortal(
    <div
      data-timeline-codex-skill-picker="true"
      data-canvas-floating-ui
      className="nodrag nowheel"
      onMouseDown={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
      style={{
        position: 'fixed',
        left: skillPickerAnchor?.left ?? 24,
        top: skillPickerAnchor?.top ?? 120,
        width: skillPickerAnchor?.width ?? 380,
        maxWidth: 'calc(100vw - 24px)',
        maxHeight: 'min(540px, calc(100vh - 40px))',
        zIndex: 10020,
        border: '1px solid var(--t8-accent, #d946ef)',
        borderRadius: 14,
        background: 'var(--t8-bg-node, rgba(10,15,24,.98))',
        color: 'var(--t8-text-main, #f8fafc)',
        boxShadow: isPixel ? '4px 4px 0 rgba(0,0,0,0.85)' : '0 24px 70px rgba(0,0,0,0.45)',
        overflow: 'hidden',
      }}
    >
      <div className="flex items-center justify-between gap-2 border-b px-3 py-2" style={{ borderColor: border, background: 'var(--t8-bg-panel, rgba(15,23,42,.72))' }}>
        <div className="min-w-0">
          <div className="truncate text-xs font-black">选择 Skill</div>
          <div className="truncate text-[10px]" style={mutedStyle}>共 {codexSkills.length} 个可用 Skill</div>
        </div>
        <button type="button" className="nodrag rounded-md border p-1" style={{ borderColor: border }} onClick={closeSkillPicker} title="关闭">
          <X size={14} />
        </button>
      </div>
      <div className="p-2">
        <div className="relative mb-2 min-w-0">
          <Search size={13} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2" style={mutedStyle} />
          <input
            data-codex-skill-search="true"
            className="nodrag w-full min-w-0 rounded-lg border py-2 pl-7 pr-2 text-xs outline-none"
            style={inputStyle}
            value={skillSearchQuery}
            placeholder="搜索 Skill，例如 image / design / figma"
            autoFocus
            onChange={(event) => setSkillSearchQuery(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') closeSkillPicker();
            }}
          />
        </div>
        {selectedCodexSkillNames.length > 0 && (
          <button
            type="button"
            className="nodrag mb-2 w-full rounded-md border px-2 py-1.5 text-left text-[11px] font-bold"
            style={{ borderColor: border, background: 'color-mix(in srgb, var(--t8-accent, #d946ef) 14%, transparent)' }}
            onClick={() => update({ codexSelectedSkillNames: [] })}
          >
            清空已选 Skill
          </button>
        )}
        <div className="max-h-[360px] overflow-y-auto pr-1" style={{ overscrollBehavior: 'contain' }} onWheel={(event) => event.stopPropagation()}>
          {filteredCodexSkills.map((skill) => {
            const active = selectedCodexSkillNames.includes(skill.name);
            return (
              <button
                key={`${skill.scope}:${skill.name}`}
                type="button"
                data-codex-skill-option={skill.name}
                className="nodrag mb-1 w-full rounded-md border px-2 py-1.5 text-left"
                style={{
                  borderColor: active ? 'var(--t8-accent, #d946ef)' : border,
                  background: active ? 'color-mix(in srgb, var(--t8-accent, #d946ef) 14%, transparent)' : 'var(--t8-bg-panel, rgba(15,23,42,.52))',
                  color: 'var(--t8-text-main, #f8fafc)',
                }}
                onClick={() => chooseSkillFromPicker(skill)}
              >
                <span className="block truncate text-xs font-black">{active ? '✓ ' : ''}${skill.name}</span>
                <span className="block truncate text-[10px]" style={mutedStyle}>{skillPurposeLabel(skill)}</span>
              </button>
            );
          })}
          {filteredCodexSkills.length === 0 && (
            <div className="rounded-lg border px-3 py-3 text-xs" style={{ borderColor: border, ...mutedStyle }}>
              没有匹配的 Skill
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  ) : null;
  return (
    <>
      {skillPickerPortal}
      {keyframeStudio}
      <div
        className={`relative w-[480px] overflow-visible rounded-2xl border-2 text-sm shadow-2xl transition-all ${selected ? 'shadow-fuchsia-500/20' : ''}`}
        style={{
          background: 'var(--t8-bg-node, rgba(10,15,24,.95))',
          color: 'var(--t8-text-main, #f8fafc)',
          borderColor: selected ? 'var(--t8-accent, #d946ef)' : border,
        }}
      >
      <Handle type="target" id="text" position={Position.Left} style={{ ...timelineHandleStyle, top: timelineHandleTop(0, 4), background: PORT_COLOR.text }} />
      <Handle type="target" id="image" position={Position.Left} style={{ ...timelineHandleStyle, top: timelineHandleTop(1, 4), background: PORT_COLOR.image }} />
      <Handle type="target" id="video" position={Position.Left} style={{ ...timelineHandleStyle, top: timelineHandleTop(2, 4), background: PORT_COLOR.video }} />
      <Handle type="target" id="audio" position={Position.Left} style={{ ...timelineHandleStyle, top: timelineHandleTop(3, 4), background: PORT_COLOR.audio }} />
      <Handle type="source" id="text" position={Position.Right} style={{ ...timelineHandleStyle, top: timelineHandleTop(0, 5), background: PORT_COLOR.text }} />
      <Handle type="source" id="image" position={Position.Right} style={{ ...timelineHandleStyle, top: timelineHandleTop(1, 5), background: PORT_COLOR.image }} />
      <Handle type="source" id="video" position={Position.Right} style={{ ...timelineHandleStyle, top: timelineHandleTop(2, 5), background: PORT_COLOR.video }} />
      <Handle type="source" id="audio" position={Position.Right} style={{ ...timelineHandleStyle, top: timelineHandleTop(3, 5), background: PORT_COLOR.audio }} />
      <Handle type="source" id="model3d" position={Position.Right} style={{ ...timelineHandleStyle, top: timelineHandleTop(4, 5), background: PORT_COLOR.model3d }} />

      {resourcePicker}
      {previewImageUrl && (
        <div
          className="nodrag nopan absolute inset-3 z-[60] flex flex-col rounded-lg border p-2 shadow-2xl"
          style={{
            background: 'var(--t8-bg-node, rgba(10,15,24,.98))',
            borderColor: border,
            color: 'var(--t8-text-main, #f8fafc)',
          }}
          onPointerDown={(event) => event.stopPropagation()}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <div className="mb-2 flex items-center gap-2">
            <div className="min-w-0 flex-1 truncate text-[11px] font-semibold">{fileName(previewImageUrl)}</div>
            <button
              type="button"
              className="flex h-7 w-7 items-center justify-center rounded border"
              style={{ borderColor: border }}
              onClick={() => setPreviewImageUrl('')}
              title="关闭预览"
              aria-label="关闭预览"
            >
              <X size={13} />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-hidden rounded bg-black/45">
            <SmartImage src={previewImageUrl} alt="" className="h-full w-full object-contain" />
          </div>
        </div>
      )}

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

      <div className="space-y-1.5 p-2.5 nodrag">
        <div className="space-y-1.5 rounded-xl border border-white/10 bg-white/[0.03] p-1.5">
          <button
            type="button"
            onClick={() => update({ advancedProviderOpen: !d?.advancedProviderOpen })}
            className="nodrag flex h-8 w-full items-center justify-between rounded-lg px-2 py-1 text-[10px] font-semibold hover:bg-white/5"
            style={mutedStyle}
          >
            <span>高级来源</span>
            <span>{activeJimeng ? activeJimeng.label || activeJimeng.id : '未配置即梦 CLI'}</span>
          </button>
          {d?.advancedProviderOpen && (
            <div className="grid grid-cols-2 gap-1.5">
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

        <div className="grid grid-cols-[minmax(0,2fr)_minmax(82px,0.75fr)_minmax(88px,0.75fr)_minmax(70px,auto)] items-center gap-1.5">
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
          <select className={`${controlCls} min-w-0`} style={inputStyle} value={ratio} onChange={(e) => update({ ratio: e.target.value })}>
            {RATIO_OPTIONS.map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
          <select className={`${controlCls} min-w-0`} style={inputStyle} value={resolution} onChange={(e) => update({ resolution: e.target.value })}>
            {RESOLUTION_OPTIONS.map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
          <label className={`${controlCls} flex min-w-[74px] items-center justify-center gap-1 px-1.5`} style={inputStyle} title="生成音频">
            <input type="checkbox" checked={generateAudio} onChange={(e) => update({ generateAudio: e.target.checked })} />
            <span>音频</span>
          </label>
        </div>

        {/* 时间线(镜头块,永远可见) */}
        <div className={cardCls} style={cardStyle}>
          <div className="mb-1.5 flex items-center justify-between text-[11px]">
            <span className="font-semibold">秒级时间线</span>
            <button type="button" className={btnCls} style={{ borderColor: border }} disabled={!canAddBlock} onClick={addBlock}>
              <Plus size={11} /> 加镜头
            </button>
          </div>
          <div className="mb-1.5">
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
              className="nodrag min-h-[56px] w-full resize-none rounded-lg border px-2 py-1 text-xs outline-none"
              style={inputStyle}
            />
          </div>
          <div ref={timelineRef} className="flex h-12 min-w-0 items-stretch overflow-hidden rounded-lg border nodrag nopan" style={{ borderColor: border }}>
            {blocks.map((b, i) => {
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
                      flex: Math.max(1, b.durationSec),
                      borderColor: subBorder,
                      background: active
                        ? 'color-mix(in srgb, var(--t8-accent, #d946ef) 26%, var(--t8-bg-panel, #111827))'
                        : 'var(--t8-bg-panel, rgba(15,23,42,.42))',
                    }}
                    title="点击编辑；拖动右侧小条调整时长"
                  >
                    <div className="truncate font-semibold">{`镜头${i + 1}`}</div>
                    <div style={mutedStyle}>{round1(b.durationSec)}s</div>
                    {/* 状态点:有图=绿,无图=黄 */}
                    <span className="absolute bottom-1 left-1 h-1.5 w-1.5 rounded-full" style={{ background: b.imageUrl ? '#34d399' : '#fbbf24' }} title={b.imageUrl ? '已设图' : '未设图'} />
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
                  </div>
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
                </Fragment>
              );
            })}
          </div>
          <div className="mt-1.5 text-[10px]" style={mutedStyle}>点镜头块/拖块缘或↔ 调时长；支持 1-9 张图，所有镜头都计入总时长。</div>
        </div>

        {/* Codex Agent 生帧入口 */}
        <div className="grid min-w-0 gap-1.5">
          <div className="grid min-w-0 grid-cols-[auto_auto_minmax(92px,124px)_minmax(104px,1fr)_auto] items-center gap-1.5">
            <span className="shrink-0 text-[11px] font-semibold">分镜编辑</span>
            {activeBlock && (
              <label className="flex h-8 shrink-0 items-center gap-1 text-[11px]" style={mutedStyle}>
                时长
                <input
                  type="number"
                  step={0.1}
                  min={SEG_MIN}
                  max={SEG_MAX}
                  className={`${controlCls} w-12 text-xs`}
                  style={inputStyle}
                  value={activeBlock.durationSec}
                  onChange={(e) => patchBlock(activeBlock.id, {
                    durationSec: clampTimelineDirectorSegmentDuration(blocks, activeIndex, round1(Number(e.target.value) || 0)),
                  })}
                />
                s
              </label>
            )}
            <button
              type="button"
              data-timeline-codex-skill-trigger="true"
              className="nodrag h-8 min-w-0 rounded-full border px-3 py-1 text-left text-[11px] font-semibold leading-normal outline-none disabled:opacity-60"
              style={{
                borderColor: selectedCodexSkillNames.length ? 'rgba(0,0,0,.78)' : border,
                background: selectedCodexSkillNames.length ? '#54c8bf' : inputStyle.background,
                color: selectedCodexSkillNames.length ? '#071314' : inputStyle.color,
              }}
              disabled={codexSkillLoading || codexSkills.length === 0}
              onClick={(event) => openSkillPicker(event.currentTarget, skillSearchQuery)}
              title="挂载技能"
            >
              <span className="block truncate">
                {codexSkillLoading ? '读取...' : selectedCodexSkillNames.length ? `Skill ${selectedCodexSkillNames.length}` : '挂载技能'}
              </span>
            </button>
            <button type="button" className={btnCls} style={{ borderColor: border }} onClick={() => setCodexStudioOpen(true)} title="打开 Codex 创作台">
              <PanelRightOpen size={11} /> 创作台
            </button>
            <span
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border"
              style={{
                borderColor: codexImageGenerationReady ? '#22c55e' : subBorder,
                color: codexImageGenerationReady ? '#22c55e' : 'var(--t8-text-muted, rgba(248,250,252,.62))',
                background: codexImageGenerationReady ? 'color-mix(in srgb, #22c55e 10%, transparent)' : 'transparent',
              }}
              title={codexImageGenerationReady ? '后端已就绪' : codexKeyframeTitle}
            >
              {codexStatusLoading ? <Loader2 size={11} className="animate-spin" /> : <Check size={12} />}
            </span>
          </div>
          {agentMessage && (
            <div className="truncate rounded-lg border px-2 py-1 text-[10px]" style={{ borderColor: subBorder, ...mutedStyle }}>
              {agentMessage}
            </div>
          )}
          {!agentMessage && d.agentStoryboardMessage && (
            <div className="truncate rounded-lg border px-2 py-1 text-[10px]" style={{ borderColor: subBorder, ...mutedStyle }}>
              {d.agentStoryboardMessage}
            </div>
          )}
        </div>

        {/* 选中镜头编辑面板 */}
        {activeBlock ? (
          <div className={cardCls} style={cardStyle} onKeyDownCapture={stopDeleteFromCanvas}>
            {/* 缩略图 */}
            <div className="relative mb-1.5 flex h-24 min-w-0 w-full items-center justify-center overflow-hidden rounded-xl border" style={{ borderColor: subBorder, background: 'rgba(0,0,0,.2)' }}>
              <input
                aria-label="图名"
                className="nodrag absolute left-2 top-2 z-10 h-6 max-w-[220px] rounded-lg border border-white/15 bg-black/55 px-1.5 text-[10px] font-semibold text-white outline-none"
                value={activeBlock.imageName}
                placeholder="图名"
                onChange={(e) => patchBlock(activeBlock.id, { imageName: sanitizeTimelineImageName(e.target.value, activeBlock.imageUrl, activeIndex) })}
              />
              {activeBlock.imageUrl && (
                <button
                  type="button"
                  className="nodrag absolute right-2 top-2 z-10 flex h-6 w-6 items-center justify-center rounded-lg border border-white/30 bg-black/55 text-white transition hover:bg-rose-500"
                  onClick={(event) => {
                    event.stopPropagation();
                    patchBlock(activeBlock.id, { imageUrl: '', imageName: '' });
                  }}
                  title="清空当前镜头图片"
                  aria-label="清空当前镜头图片"
                >
                  <X size={13} />
                </button>
              )}
              {activeBlock.imageUrl ? <SmartImage src={activeBlock.imageUrl} alt="" className="h-full w-full object-contain" /> : <span className="text-[11px] opacity-40">未设图片</span>}
            </div>

            {/* 换图来源 */}
            <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)] gap-1.5">
              <button type="button" className={`${btnCls} min-w-0`} style={{ borderColor: border }} onClick={() => uploadImageRef.current?.click()}><ImageIcon size={13} /> <span className="truncate">上传图</span></button>
              <button type="button" className={`${btnCls} min-w-0`} style={{ borderColor: border }} onClick={() => uploadVideoRef.current?.click()}><VideoIcon size={13} /> <span className="truncate">上传视频</span></button>
              <button type="button" className={`${btnCls} min-w-0`} style={{ borderColor: border }} onClick={() => uploadAudioRef.current?.click()}><Music size={13} /> <span className="truncate">上传音频</span></button>
            </div>
            <div className="mt-1.5 grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)] gap-1.5">
              <button type="button" className={`${btnCls} min-w-0`} style={{ borderColor: border }} onClick={() => openResourcePicker('image')}><Library size={13} /> <span className="truncate">资源图</span></button>
              <button type="button" className={`${btnCls} min-w-0`} style={{ borderColor: border }} onClick={() => openResourcePicker('video')}><Library size={13} /> <span className="truncate">资源视频</span></button>
              <button type="button" className={`${btnCls} min-w-0`} style={{ borderColor: border }} onClick={() => openResourcePicker('audio')}><Library size={13} /> <span className="truncate">资源音频</span></button>
            </div>

            <input ref={uploadImageRef} type="file" accept="image/*" multiple className="hidden" onChange={(event) => handleUpload('image', event)} />
            <input ref={uploadVideoRef} type="file" accept="video/*" multiple className="hidden" onChange={(event) => handleUpload('video', event)} />
            <input ref={uploadAudioRef} type="file" accept="audio/*" multiple className="hidden" onChange={(event) => handleUpload('audio', event)} />

            <div className="mt-2">
              {renderReferencePool()}
            </div>

            <div className="mt-1.5">
              <div className="mb-1 text-[10px]" style={mutedStyle}>描述词</div>
              <MentionPromptInput
                value={activeBlock.prompt}
                mentions={activeBlock.mentions}
                materials={mentionMaterials}
                onChange={(value, mentions) => patchBlock(activeBlock.id, { prompt: value, mentions })}
                placeholder="写这个镜头的画面、动作、镜头语言；输入 @ 可引用素材"
                isDark={isDark}
                isPixel={isPixel}
                expandable
                promptTemplateKind="video"
                title="描述词"
              />
            </div>

            {/* 镜头操作 */}
            <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)] gap-1.5 mt-1.5">
              <button type="button" disabled={activeIndex === 0} className={`${btnCls} min-w-0`} style={{ borderColor: border }} onClick={() => moveBlock(activeBlock.id, -1)}><ArrowLeft size={12} /> <span className="truncate">左移</span></button>
              <button type="button" disabled={activeIndex === blocks.length - 1} className={`${btnCls} min-w-0`} style={{ borderColor: border }} onClick={() => moveBlock(activeBlock.id, 1)}><span className="truncate">右移</span> <ArrowRight size={12} /></button>
              <button type="button" disabled={!canAddBlock} className={`${btnCls} min-w-0`} style={{ borderColor: border }} onClick={() => duplicateBlock(activeBlock.id)}><Copy size={12} /> <span className="truncate">复制</span></button>
              <button type="button" disabled={blocks.length <= 1} className={`${btnCls} min-w-0`} style={{ borderColor: border }} onClick={() => removeBlock(activeBlock.id)}><Trash2 size={12} className="text-rose-400" /> <span className="truncate">删除</span></button>
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
                引用素材：{compiled.videos.length} 视频 / {compiled.audios.length} 音频
              </div>
            )}
            <div className="font-semibold">Prompt</div>
            <div className="whitespace-pre-wrap">{compiled.prompt || '(空)'}</div>
          </div>
        </details>

        {error && <div className="flex items-start gap-1 text-[11px] text-rose-400"><AlertCircle size={13} className="mt-0.5 shrink-0" /> {error}</div>}
        {!totalValid && blocks.length >= 1 && imagedCount < blocks.length && <div className="text-[10px] text-amber-400">还有 {blocks.length - imagedCount} 个镜头未设图</div>}
        {!totalValid && imagedCount === blocks.length && (totalDuration < MIN_TOTAL || totalDuration > MAX_TOTAL) && <div className="text-[10px] text-amber-400">总时长 {totalDuration}s 需在 {MIN_TOTAL}-{MAX_TOTAL}s</div>}
        {!totalValid && imagedCount === blocks.length && totalRequestImages > MAX_IMAGES && <div className="text-[10px] text-amber-400">图片总数 {totalRequestImages} 张，需不超过 {MAX_IMAGES} 张</div>}

        {latestVideoUrl && <div className="rounded-lg overflow-hidden border" style={{ borderColor: border }}><LoopingVideo src={latestVideoUrl} className="w-full" /></div>}

        <div className="grid grid-cols-2 gap-1.5">
          <button
            type="button"
            onClick={running ? undefined : handleGenerate}
            disabled={!totalValid || running}
            className="nodrag flex h-9 items-center justify-center gap-1.5 rounded-xl border px-3 py-2 text-xs font-semibold disabled:opacity-50"
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
          <div className="flex h-9 items-center gap-2 rounded-xl border px-2 py-2 text-[11px]" style={{ borderColor: subBorder }}>
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
    </>
  );
};

export default memo(TimelineDirectorNode);
