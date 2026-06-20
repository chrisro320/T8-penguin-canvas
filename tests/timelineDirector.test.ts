import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildTimelineDirectorExternalVideoRequest,
  buildTimelineDirectorLlmOptimizationPrompt,
  sanitizeTimelineDirectorBlocks,
  type TimelineDirectorBlockInput,
} from '../src/utils/timelineDirector.ts';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

test('timeline director compiles keyframe names roles durations and prompts into Jimeng multiframe request', () => {
  const blocks: TimelineDirectorBlockInput[] = [
    {
      id: 'a',
      title: '女主设定',
      imageUrl: '/files/input/hero.png',
      imageName: '女主A',
      imageRole: 'character',
      durationSec: 0.2,
      prompt: '女主从画面左侧转身看向镜头',
    },
    {
      id: 'b',
      title: '720环境图',
      imageUrl: '/files/input/env.png',
      imageName: '室内大厅720',
      imageRole: 'environment-720',
      durationSec: 9.3,
      prompt: '镜头推入大厅，保持人物身份一致',
    },
    {
      id: 'c',
      title: '故事板03',
      imageUrl: '/files/input/storyboard.png',
      imageName: '故事板03',
      imageRole: 'storyboard',
      durationSec: 4,
      prompt: '末帧不发送',
    },
  ];

  const request = buildTimelineDirectorExternalVideoRequest(blocks, {
    providerId: 'jimeng-cli',
    providerModel: 'seedance2.0fast_vip',
    model: 'seedance2.0fast_vip',
    generateAudio: true,
    seed: 42,
    globalStyle: '电影感，暖色光',
    videos: ['/files/input/ref-video.mp4'],
    audios: ['/files/input/ref-audio.wav'],
  });

  assert.deepEqual(request.images, ['/files/input/hero.png', '/files/input/env.png', '/files/input/storyboard.png']);
  assert.deepEqual(request.videos, ['/files/input/ref-video.mp4']);
  assert.deepEqual(request.audios, ['/files/input/ref-audio.wav']);
  assert.equal(request.duration, 8.5);
  assert.equal(request.seed, 42);
  assert.equal(request.providerParams?.frameMode, 'multiframe');
  assert.deepEqual(request.providerParams?.transitionDurations, [0.5, 8]);
  assert.equal(request.providerParams?.generate_audio, true);
  assert.deepEqual(request.providerParams?.timelineReferenceVideos, ['/files/input/ref-video.mp4']);
  assert.deepEqual(request.providerParams?.timelineReferenceAudios, ['/files/input/ref-audio.wav']);
  assert.equal(request.providerParams?.transitionPrompts.length, 2);
  assert.equal(request.providerParams?.transitionPrompts[0], '@女主A -> @室内大厅720\n时长：0.5秒\n女主从画面左侧转身看向镜头');
  assert.equal(request.providerParams?.transitionPrompts[1], '@室内大厅720 -> @故事板03\n时长：8秒\n镜头推入大厅，保持人物身份一致');
  assert.doesNotMatch(request.providerParams?.transitionPrompts[0], /关键帧图|图片定位|时长约束|描述词/);
  assert.match(request.prompt, /全局要求：电影感，暖色光/);
  assert.match(request.prompt, /素材定位：@女主A=人设图；@室内大厅720=720环境图；@故事板03=故事板图/);
  assert.equal((request.prompt.match(/素材定位/g) || []).length, 1);
});

test('timeline director sanitizes legacy blocks and keeps stable @ tokens from image names', () => {
  const [first, second] = sanitizeTimelineDirectorBlocks([
    { id: 'x', title: ' 角色 图 ', imageUrl: '/files/input/role.png', durationSec: 3, prompt: 'a' },
    { id: 'y', imageUrl: '/files/input/scene 01.png?x=1', imageRole: 'environment-720', durationSec: 4, prompt: 'b' },
  ]);

  assert.equal(first.imageName, '角色图');
  assert.equal(first.mentionToken, '@角色图');
  assert.equal(first.imageRole, 'keyframe');
  assert.equal(second.imageName, 'scene_01');
  assert.equal(second.mentionToken, '@scene_01');
  assert.equal(second.imageRole, 'environment-720');
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
  ], { mode: 'full', globalStyle: '写实电影感' });

  assert.match(system, /时间分镜描述/);
  assert.match(system, /保留所有 @图片名/);
  assert.match(user, /第1段/);
  assert.match(user, /关键帧图：@女主A → @大厅720/);
  assert.match(user, /图片定位：@女主A=人设图；@大厅720=720环境图/);
  assert.match(user, /时长约束：1\.2s/);
  assert.match(user, /描述词：转身/);
  assert.match(user, /写实电影感/);
});

test('timeline director frontend exposes storyboard-aligned controls without shot override and bridge clutter', () => {
  const node = read('../src/components/nodes/TimelineDirectorNode.tsx');

  assert.match(node, /buildTimelineDirectorExternalVideoRequest/);
  assert.match(node, /buildTimelineDirectorLlmOptimizationPrompt/);
  assert.match(node, /w-\[460px\]/);
  assert.match(node, /时间轴导演台/);
  assert.match(node, /高级来源/);
  assert.match(node, /秒级时间线/);
  assert.match(node, /加分镜/);
  assert.match(node, /S\$\{activeIndex \+ 1\}/);
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
  assert.match(node, /图片定位/);
  assert.match(node, /关键帧图/);
  assert.match(node, /描述词/);
  assert.match(node, /实际发送/);
  assert.doesNotMatch(node, /上游图/);
  assert.doesNotMatch(node, /镜头覆盖/);
  assert.doesNotMatch(node, /首尾帧桥接/);
});
