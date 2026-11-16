/**
 * 生图服务与房间资产存储（M9.5d）。`room-http` 只依赖两边的结构化接口，便于单测注入假实现。
 */
export {
  MediaService,
  createMediaService,
  createFakeMediaGenerator,
  createOpenAIMediaGenerator,
  buildMediaPrompt,
  mediaRenderPlan,
  fakeMediaPng,
  fakeMediaSvg,
  type MediaAssetGenerator,
  type MediaAssetsService,
  type MediaPrincipal,
  type MediaRawImage,
  type MediaRawResult,
  type MediaRateLimit,
  type MediaRenderRequest,
  type MediaServiceOptions,
} from './media-service.ts';

export {
  RoomAssetStore,
  defaultRoomAssetsDir,
  type RoomAssetStoreOptions,
  type RoomAssetsStore,
  type StoredRoomAsset,
} from './room-asset-store.ts';
