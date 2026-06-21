import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildTimelineDirectorExternalVideoRequest,
  buildTimelineDirectorAgentPlanPrompt,
  buildTimelineDirectorLlmOptimizationPrompt,
  clampTimelineDirectorSegmentDuration,
  extractTimelineDirectorAgentPlanJson,
  normalizeTimelineDirectorAgentPlan,
  normalizeTimelineDirectorTotalDuration,
  sanitizeTimelineDirectorBlocks,
  timelineDirectorTotalDuration,
  type TimelineDirectorBlockInput,
} from '../src/utils/timelineDirector.ts';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

test('timeline director compiles shot names durations prompts and @ image refs into Jimeng request', () => {
  const blocks: TimelineDirectorBlockInput[] = [
    {
      id: 'a',
      title: '女主设定',
      imageUrl: '/files/input/hero.png',
      imageName: '女主A',
      durationSec: 0.2,
      prompt: '女主从画面左侧转身看向镜头',
    },
    {
      id: 'b',
      title: '720环境图',
      imageUrl: '/files/input/env.png',
      imageName: '室内大厅720',
      durationSec: 9.3,
      prompt: '镜头推入大厅，保持人物身份一致',
    },
    {
      id: 'c',
      title: '故事板03',
      imageUrl: '/files/input/storyboard.png',
      imageName: '故事板03',
      durationSec: 4,
      prompt: '故事板收束镜头，人物停在雨幕前',
    },
  ];

  const request = buildTimelineDirectorExternalVideoRequest(blocks, {
    providerId: 'jimeng-cli',
    providerModel: 'seedance2.0fast_vip',
    model: 'seedance2.0fast_vip',
    generateAudio: true,
    seed: 42,
    globalStyle: '这个旧字段不应该被拼进请求',
    referenceImages: ['/files/input/male-lead.png'],
    globalPrompt: '@女主A 保持身份一致；室内暖光。',
    videos: ['/files/input/ref-video.mp4'],
    audios: ['/files/input/ref-audio.wav'],
  });

  assert.deepEqual(request.images, ['/files/input/male-lead.png', '/files/input/hero.png', '/files/input/env.png', '/files/input/storyboard.png']);
  assert.deepEqual(request.videos, ['/files/input/ref-video.mp4']);
  assert.deepEqual(request.audios, ['/files/input/ref-audio.wav']);
  assert.equal(request.duration, 14.3);
  assert.equal(request.seed, 42);
  assert.equal(request.providerParams?.frameMode, 'omni');
  assert.deepEqual(request.providerParams?.transitionDurations, [1, 9.3]);
  assert.deepEqual(request.providerParams?.timelineReferenceImages, ['/files/input/male-lead.png']);
  assert.deepEqual(request.providerParams?.timelineFrameImages, ['/files/input/hero.png', '/files/input/env.png', '/files/input/storyboard.png']);
  assert.equal(request.providerParams?.generate_audio, true);
  assert.deepEqual(request.providerParams?.timelineReferenceVideos, ['/files/input/ref-video.mp4']);
  assert.deepEqual(request.providerParams?.timelineReferenceAudios, ['/files/input/ref-audio.wav']);
  assert.equal(request.providerParams?.transitionPrompts.length, 2);
  assert.equal(request.prompt, '@女主A 保持身份一致；室内暖光。\n\n@女主A -> @室内大厅720\n时长：1秒\n女主从画面左侧转身看向镜头\n\n@室内大厅720 -> @故事板03\n时长：9.3秒\n镜头推入大厅，保持人物身份一致\n\n@故事板03\n时长：4秒\n故事板收束镜头，人物停在雨幕前');
  assert.deepEqual(request.providerParams?.transitionPrompts, [request.prompt, request.prompt]);
  assert.doesNotMatch(request.prompt, /全局要求|素材定位|图片定位|关键帧图|人设图|720环境图|故事板图|这个旧字段/);
  assert.equal((request.prompt.match(/@女主A/g) || []).length, 2);
  assert.equal((request.prompt.match(/@女主A 保持身份一致/g) || []).length, 1);
});

test('timeline director supports single-frame video request', () => {
  const request = buildTimelineDirectorExternalVideoRequest([
    {
      id: 'solo',
      title: '单镜头',
      imageUrl: '/files/input/solo.png',
      imageName: '单镜头图',
      durationSec: 4.5,
      prompt: '人物看向镜头，轻微推近',
    },
  ], {
    providerId: 'jimeng-cli',
    providerModel: 'seedance2.0fast_vip',
    globalPrompt: '@单镜头图 保持角色一致',
  });

  assert.deepEqual(request.images, ['/files/input/solo.png']);
  assert.equal(request.duration, 4.5);
  assert.deepEqual(request.providerParams?.transitionDurations, []);
  assert.deepEqual(request.providerParams?.transitionPrompts, []);
  assert.equal(request.prompt, '@单镜头图 保持角色一致\n\n@单镜头图\n时长：4.5秒\n人物看向镜头，轻微推近');
});

test('timeline director sanitizes legacy blocks and keeps stable @ tokens from image names', () => {
  const [first, second] = sanitizeTimelineDirectorBlocks([
    { id: 'x', title: ' 角色 图 ', imageUrl: '/files/input/role.png', durationSec: 3, prompt: 'a' },
    { id: 'y', imageUrl: '/files/input/scene 01.png?x=1', imageRole: 'environment-720', durationSec: 4, prompt: 'b' },
  ]);

  assert.equal(first.imageName, '角色图');
  assert.equal(first.mentionToken, '@角色图');
  assert.equal(second.imageName, 'scene_01');
  assert.equal(second.mentionToken, '@scene_01');
});

test('timeline director enforces total duration between 4 and 15 seconds while editing', () => {
  const tooLong = normalizeTimelineDirectorTotalDuration([
    { id: 'a', imageUrl: '/a.png', durationSec: 12 },
    { id: 'b', imageUrl: '/b.png', durationSec: 12 },
    { id: 'c', imageUrl: '/c.png', durationSec: 2 },
    { id: 'd', imageUrl: '/d.png', durationSec: 3 },
  ]);

  assert.equal(timelineDirectorTotalDuration(tooLong), 15);
  assert.ok(tooLong.every((block) => block.durationSec >= 1 && block.durationSec <= 12));

  const tooShort = normalizeTimelineDirectorTotalDuration([
    { id: 'a', imageUrl: '/a.png', durationSec: 0.5 },
    { id: 'b', imageUrl: '/b.png', durationSec: 0.5 },
  ]);
  assert.equal(timelineDirectorTotalDuration(tooShort), 4);
  assert.equal(tooShort[0].durationSec, 3);

  assert.equal(clampTimelineDirectorSegmentDuration(tooLong, 0, 12), 1);
  assert.equal(clampTimelineDirectorSegmentDuration([
    { id: 'a', durationSec: 12 },
    { id: 'b', durationSec: 12 },
    { id: 'c', durationSec: 2 },
    { id: 'd', durationSec: 3 },
  ], 1, 12), 1);
  assert.equal(clampTimelineDirectorSegmentDuration([
    { id: 'a', durationSec: 2 },
    { id: 'b', durationSec: 1 },
    { id: 'c', durationSec: 3 },
  ], 1, 0.5), 1);
  assert.equal(clampTimelineDirectorSegmentDuration([
    { id: 'a', durationSec: 2 },
    { id: 'b', durationSec: 3 },
  ], 0, 99), 12);
});

test('timeline director LLM optimization prompt is a real time-storyboard script contract', () => {
  const { system, user } = buildTimelineDirectorLlmOptimizationPrompt([
    {
      id: 'a',
      imageUrl: '/files/input/hero.png',
      imageName: '女主A',
      imageRole: 'character',
      durationSec: 1.2,
      prompt: '转身',
    },
    {
      id: 'b',
      imageUrl: '/files/input/env.png',
      imageName: '大厅720',
      imageRole: 'environment-720',
      durationSec: 2,
      prompt: '走入大厅',
    },
  ], { mode: 'full', globalStyle: '写实电影感', globalPrompt: '@女主A 保持红色外套' });

  assert.match(system, /时间分镜描述/);
  assert.match(system, /保留所有 @图片名/);
  assert.match(user, /第1段/);
  assert.match(user, /@女主A -> @大厅720/);
  assert.match(user, /时长：1\.2秒/);
  assert.match(user, /转身/);
  assert.match(user, /@女主A 保持红色外套/);
  assert.doesNotMatch(user, /关键帧图|图片定位|时长约束|描述词|写实电影感/);
});

test('timeline director Codex agent plan parses JSON and normalizes shot contract', () => {
  const prompt = buildTimelineDirectorAgentPlanPrompt({
    script: '男主走进大厅，发现窗外下雨。',
    globalPrompt: '@男主 是主角，保持黑色外套。',
    compiledPrompt: '@男主 -> @大厅\n时长：2秒\n走入大厅',
    blocks: [
      { id: 'a', imageName: '男主', durationSec: 2, prompt: '走入大厅' },
      { id: 'b', imageName: '大厅', durationSec: 2, prompt: '' },
    ],
    referenceImageCount: 2,
    maxShots: 9,
  });

  assert.match(prompt.system, /只返回 JSON/);
  assert.match(prompt.system, /imagePrompt/);
  assert.match(prompt.system, /默认优先拆成 4-6 个镜头/);
  assert.match(prompt.system, /2x2 或 2x3 宫格关键帧图/);
  assert.match(prompt.user, /元脚本/);
  assert.match(prompt.user, /参考图数量：2/);

  const parsed = extractTimelineDirectorAgentPlanJson(`说明文字\n\`\`\`json\n{
    "globalPrompt": "@男主 保持身份",
    "shots": [
      {"title":"入场","imageName":"男主入场","durationSec":0.2,"prompt":"男主推门进入","imagePrompt":"男主站在门口，黑色外套"},
      {"title":"发现","imageName":"窗边发现","durationSec":20,"prompt":"男主看向窗外雨幕","imagePrompt":"窗边雨幕，男主侧脸"},
      {"title":"反应","imageName":"男主反应","durationSec":3,"prompt":"男主皱眉停顿","imagePrompt":"男主特写，紧张表情"}
    ]
  }\n\`\`\``);
  const plan = normalizeTimelineDirectorAgentPlan(parsed, { maxShots: 9 });

  assert.equal(plan.globalPrompt, '@男主 保持身份');
  assert.equal(plan.shots.length, 3);
  assert.equal(plan.shots[0].imageName, '男主入场');
  assert.equal(plan.shots[0].durationSec, 1);
  assert.ok(timelineDirectorTotalDuration(plan.shots) <= 15);
  assert.ok(plan.shots.every((shot) => shot.durationSec >= 1 && shot.durationSec <= 12));
  assert.match(plan.shots[1].imagePrompt, /窗边雨幕/);
});

test('timeline director frontend exposes storyboard-aligned controls without shot override and bridge clutter', () => {
  const node = read('../src/components/nodes/TimelineDirectorNode.tsx');
  const ports = read('../src/config/portTypes.ts');

  assert.match(node, /buildTimelineDirectorExternalVideoRequest/);
  assert.match(node, /buildTimelineDirectorAgentPlanPrompt/);
  assert.match(node, /streamCodexImageConjure/);
  assert.match(node, /opGridCrop/);
  assert.match(node, /handleAgentStoryboard/);
  assert.match(node, /getCodexCliStatus/);
  assert.match(node, /extractTimelineDirectorAgentPlanJson/);
  assert.match(node, /normalizeTimelineDirectorAgentPlan/);
  assert.match(node, /getCodexCliSkills/);
  assert.match(node, /streamCodexCliAgent/);
  assert.match(node, /callCodexAgent/);
  assert.match(node, /handleCodexStudioRun/);
  assert.match(node, /createPortal/);
  assert.match(node, /keyframeStudioOpen/);
  assert.match(node, /codexStudioOpen/);
  assert.match(node, /Codex 创作台/);
  assert.match(node, /PanelRightOpen/);
  assert.match(node, /codexAgentTaskPrompt/);
  assert.match(node, /codexModel/);
  assert.match(node, /codexWebSearch/);
  assert.match(node, /codexIncludePlanTool/);
  assert.match(node, /codexSandbox/);
  assert.match(node, /codexApprovalPolicy/);
  assert.match(node, /codexReasoningEffort/);
  assert.match(node, /codexSelectedSkillNames/);
  assert.match(node, /selectedSkillNames:\s*selectedCodexSkillNames/);
  assert.match(node, /planningOnly:\s*true/);
  assert.match(node, /const referenceImages = dedupe\(\[\.\.\.localRefImages, \.\.\.requestImages, \.\.\.codexTaskMentionedMedia\.images\]\)/);
  assert.match(node, /images:\s*options\.referenceImages/);
  assert.match(node, /videos:\s*options\.referenceVideos/);
  assert.match(node, /audios:\s*options\.referenceAudios/);
  assert.match(node, /referenceTexts:\s*options\.referenceTexts/);
  assert.doesNotMatch(node, /images:\s*dedupe\(\[\.\.\.localRefImages,\s*\.\.\.requestImages,\s*\.\.\.timelineImageUrls\]\)/);
  assert.doesNotMatch(node, /referenceTexts:\s*\[compiledPrompt\]/);
  assert.match(node, /api\.addResourceItem/);
  assert.match(node, /localRefImages:/);
  assert.match(node, /generatedUrls/);
  assert.match(node, /gridImageUrl/);
  assert.match(node, /agentStoryboardGridImageUrl/);
  assert.match(node, /agentStoryboardPlanText/);
  assert.match(node, /agentStoryboardLog/);
  assert.match(node, /outputText:\s*planText/);
  assert.match(node, /imageUrls:\s*dedupe\(\[gridImageUrl, \.\.\.generatedUrls\]\)/);
  assert.match(node, /timelineStoryboardGridLayout/);
  assert.match(node, /timelineGridAspectRatio/);
  assert.match(node, /size:\s*'2K'/);
  assert.match(node, /quality:\s*'高'/);
  assert.match(node, /exportIndexes/);
  assert.match(node, /keyframeTextReady/);
  assert.match(node, /image_generation/);
  assert.match(node, /image2/);
  assert.match(node, /宫格/);
  assert.match(node, /流式对话 · Skill 调用 · 产物库 · 脚本快拆/);
  assert.match(node, /会话列表/);
  assert.match(node, /项目内多轮创作对话/);
  assert.match(node, /新建会话/);
  assert.match(node, /agentStoryboardOutputUrls:\s*\[\]/);
  assert.match(node, /agentStoryboardGridImageUrl:\s*''/);
  assert.match(node, /agentStoryboardPlanText:\s*''/);
  assert.match(node, /项目管理/);
  assert.match(node, /新建工作区/);
  assert.match(node, /归档旧会话/);
  assert.match(node, /createNewTimelineWorkspace/);
  assert.match(node, /archiveTimelineSessions/);
  assert.match(node, /codexWorkspaceDir:\s*''/);
  assert.match(node, /codexContextLimit/);
  assert.match(node, /创作工作区/);
  assert.match(node, /Skill · 模型 · 后端参数/);
  assert.match(node, /Skill 列表/);
  assert.doesNotMatch(node, /模板分类/);
  assert.doesNotMatch(node, /创作模板/);
  assert.doesNotMatch(node, /生成后自动发布到画布输出/);
  assert.doesNotMatch(node, /提示词持久化/);
  assert.doesNotMatch(node, /素材持久化/);
  assert.match(node, /工作台工具/);
  assert.match(node, /handleCodexStudioRun\('storyboardQuickSplit'\)/);
  assert.match(node, /title="打开真实 Codex Skill 列表"/);
  assert.doesNotMatch(node, /模板工坊/);
  assert.match(node, />\s*项目 Skill\s*</);
  assert.match(node, /创作台记忆/);
  assert.doesNotMatch(node, /自动压缩成长期记忆/);
  assert.match(node, /先输入元脚本/);
  assert.match(node, /挂载技能/);
  assert.match(node, /data-timeline-codex-skill-picker/);
  assert.match(node, /data-timeline-codex-skill-trigger/);
  assert.match(node, /搜索 Skill，例如 image \/ design \/ figma/);
  assert.match(node, /skillPurposeLabel/);
  assert.match(node, /codexWorkspaceDir/);
  assert.match(node, /codexExecutablePath/);
  assert.doesNotMatch(node, /generateLlm/);
  assert.doesNotMatch(node, /generateExternalLlm/);
  assert.doesNotMatch(node, /llmProviderSelection/);
  assert.doesNotMatch(node, /llmProviderModel/);
  assert.match(node, /w-\[480px\]/);
  assert.match(node, /grid-cols-\[auto_auto_minmax\(92px,124px\)_minmax\(104px,1fr\)_auto\]/);
  assert.match(node, /<Handle type="target" id="text"/);
  assert.match(node, /<Handle type="target" id="image"/);
  assert.match(node, /<Handle type="target" id="video"/);
  assert.match(node, /<Handle type="target" id="audio"/);
  assert.match(node, /<Handle type="source" id="text"/);
  assert.match(node, /<Handle type="source" id="image"/);
  assert.match(node, /<Handle type="source" id="video"/);
  assert.match(node, /<Handle type="source" id="audio"/);
  assert.match(node, /<Handle type="source" id="model3d"/);
  assert.match(ports, /'timeline-director':\s*\{\s*inputs:\s*\['text', 'image', 'video', 'audio'\],\s*outputs:\s*\['text', 'image', 'video', 'audio', 'model3d'\]\s*\}/);
  assert.match(node, /sortedCodexSkills/);
  assert.match(node, /Skill \$\{selectedCodexSkillNames\.length\}/);
  assert.match(node, /后端已就绪/);
  assert.match(node, /脚本快拆/);
  assert.match(node, /用 Codex 作为画布里的创作副驾驶/);
  assert.match(node, /支持 @ 引用素材；Skill 通过左侧挂载；脚本快拆会拼入预置参数执行/);
  assert.match(node, /<MaterialPreviewSection/);
  assert.match(node, /onReorder=\{setMaterialOrder\}/);
  assert.match(node, /onExcludeUpstream=\{excludeUpstreamMaterial\}/);
  assert.match(node, /onRestoreExcluded=\{restoreExcludedMaterials\}/);
  assert.match(node, /filterExcludedMaterials\(upstream\.texts/);
  assert.match(node, /useOrderedMaterials\(visibleUpstreamImages/);
  assert.match(node, /连接后这里会显示缩略图，并可拖动排序或点 X 排除/);
  assert.doesNotMatch(node, /\/Skill 直接调用能力；脚本快拆/);
  assert.match(node, /codexAgentTaskPromptMentions/);
  assert.match(node, /upstreamTextContext/);
  assert.match(node, /上游文本素材/);
  assert.match(node, /referenceTexts:\s*\[upstreamTextContext, resolvedCodexAgentTaskPrompt, resolvedGlobalPromptNow\]/);
  assert.match(node, /referenceTexts:\s*\[upstreamTextContext, userPrompt, resolvedGlobalPrompt, compiledPrompt\]/);
  assert.match(node, /agentMaterials/);
  assert.match(node, /脚本快拆宫格图/);
  assert.match(node, /快拆镜头/);
  assert.match(node, /脚本快拆计划/);
  assert.match(node, /\.\.\.localMaterials, \.\.\.agentMaterials/);
  assert.match(node, /<MentionPromptInput[\s\S]*codexAgentTaskPrompt/);
  assert.match(node, /collectMentionedMedia\(codexAgentTaskPromptMentions, mentionMaterials\)/);
  assert.match(node, /resolveMediaMentions\(codexAgentTaskPrompt, codexAgentTaskPromptMentions, mentionMaterials\)/);
  assert.match(node, /codexTaskMentionedMedia\.images/);
  assert.match(node, /onClick=\{\(\) => void handleCodexStudioRun\(\)\}/);
  assert.match(node, /handleCodexStudioRun\('storyboardQuickSplit'\)/);
  assert.match(node, /脚本快拆模式：先理解脚本和参考图，再生成 2K 宫格关键帧并写回镜头/);
  assert.match(node, /USER/);
  assert.match(node, /CODEX/);
  assert.match(node, /agentStoryboardStatus/);
  assert.match(node, /agentStoryboardMessage/);
  assert.match(node, /<Check size=\{12\}/);
  assert.match(node, /<Eye size=\{11\}/);
  assert.match(node, /group-hover:block/);
  assert.match(node, /时间轴导演台/);
  assert.match(node, /高级来源/);
  assert.match(node, /生成音频/);
  assert.match(node, /秒级时间线/);
  assert.match(node, /全局提示词/);
  assert.match(node, /globalPrompt/);
  assert.match(node, /globalPromptMentions/);
  assert.match(node, /localRefImages/);
  assert.match(node, /localRefImages: dedupe\(\[\.\.\.localRefImages, \.\.\.clean\]\)/);
  assert.match(node, /renderReferencePool/);
  assert.match(node, /data-timeline-reference-pool/);
  assert.match(node, /previewImageUrl/);
  assert.match(node, /onDoubleClick/);
  assert.match(node, /预览大图/);
  assert.match(node, /关闭预览/);
  assert.match(node, /素材视频/);
  assert.match(node, /素材音频/);
  assert.match(node, /引用素材/);
  assert.match(node, /加镜头/);
  assert.match(node, /canAddBlock/);
  assert.match(node, /totalDuration < MAX_TOTAL/);
  assert.match(node, /镜头\$\{i \+ 1\}/);
  assert.match(node, /生成全部/);
  assert.match(node, /已输出/);
  assert.match(node, /重新获取/);
  assert.match(node, /grid-cols-3/);
  assert.match(node, /上传图/);
  assert.match(node, /上传视频/);
  assert.match(node, /上传音频/);
  assert.match(node, /资源图/);
  assert.match(node, /资源视频/);
  assert.match(node, /资源音频/);
  assert.match(node, /const resolution: string = d\.resolution \|\| '2k'/);
  assert.match(node, /aria-label="图名"/);
  assert.match(node, /描述词/);
  assert.match(node, /实际发送/);
  assert.match(node, /promptTemplateKind="video"/);
  assert.match(node, /onKeyDownCapture/);
  assert.match(node, /removeBlock\(activeBlock\.id\)/);
  assert.match(node, /totalRequestImages > MAX_IMAGES/);
  assert.doesNotMatch(node, /if \(kind === 'image'\) \{\s*const first[\s\S]*?setActiveImage/);
  assert.doesNotMatch(node, /if \(resourcePickerKind === 'image'\) \{\s*setActiveImage/);
  assert.doesNotMatch(node, /Seed，-1 为随机|value=\{seed\}|update\(\{ seed/);
  assert.doesNotMatch(node, /patchBlock\(activeBlock\.id, \{ title/);
  assert.doesNotMatch(node, /\[\.\.\.localRefVideos, \.\.\.mentionedMedia\.videos\]/);
  assert.doesNotMatch(node, /\[\.\.\.localRefAudios, \.\.\.mentionedMedia\.audios\]/);
  assert.doesNotMatch(node, /图片定位/);
  assert.doesNotMatch(node, /人设图|720环境图|故事板图/);
  assert.doesNotMatch(node, /全局风格/);
  assert.doesNotMatch(node, /全局视频\/音频参考|暂无全局视频\/音频参考/);
  assert.doesNotMatch(node, /加分镜|加关键帧|S\$\{activeIndex \+ 1\}|F\$\{i \+ 1\}|关键帧图名|未设关键帧图/);
  assert.doesNotMatch(node, /上游图/);
  assert.doesNotMatch(node, /镜头覆盖/);
  assert.doesNotMatch(node, /首尾帧桥接/);
});
