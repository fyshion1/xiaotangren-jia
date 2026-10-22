import { useNestStickers, StickerPicture } from './NestStickerEditor'
import UiIcon from './UiIcon'
export default function NestHero({ variant }: { variant: string }) {
  const { config, items } = useNestStickers()
  const left = items.find((g) => g.id === config.left.id)
  const right = items.find((g) => g.id === config.right.id)
  return (
    <header className="nest-hero" data-nest={variant}>
      {variant === 'n3' && (
        <div className="nest-sticker-scene" aria-hidden="true">
          {!config.left.hidden && (!config.left.id || left) && (
            <div className="nest-sticker nest-sticker-left">
              {left ? (
                <StickerPicture src={left.orig} name="左侧贴纸" />
              ) : (
                <div className="nest-sticker-photo">
                  <img src="/visual/images/gal-193cace93192.png" alt="" />
                </div>
              )}
              <span className="nest-sticker-caption">
                {left ? '一起留下的片刻' : '大诗音的小小茶会'}
              </span>
              <span className="nest-scene-prop">
                <UiIcon name="coffee" size={27} />
                <UiIcon name="cookie" size={21} />
              </span>
            </div>
          )}
          {!config.right.hidden && (!config.right.id || right) && (
            <div className="nest-sticker nest-sticker-right">
              {right ? (
                <StickerPicture src={right.orig} name="右侧贴纸" />
              ) : (
                <div className="nest-sticker-photo nest-sticker-shiro">
                  <img src="/visual/images/gal-10860c78271e.png" alt="" />
                </div>
              )}
              <span className="nest-sticker-caption">
                {right ? '喜欢的日常' : '小白也在这里呀'}
              </span>
              <span className="nest-scene-prop">
                <UiIcon name="heart" size={24} />
                <UiIcon name="paw" size={21} />
              </span>
            </div>
          )}
        </div>
      )}
      <div className="nest-hero-copy">
        <span className="nest-hero-eyebrow">一起玩 · 共同回忆</span>
        <h1>糖人小窝</h1>
        <p>把一起度过的日常，留在这里。</p>
      </div>
      <div className="nest-hero-art" aria-hidden="true">
        <UiIcon name="home" size={84} />
        <span className="nest-hero-heart">
          <UiIcon name="heart" size={23} />
        </span>
        <span className="nest-hero-flower">
          <UiIcon name="flower" size={30} />
        </span>
      </div>
      <div className="nest-hero-footnote">
        全家的收藏与活动<span>每个人的专属画廊，仍在各自介绍页。</span>
      </div>
    </header>
  )
}
