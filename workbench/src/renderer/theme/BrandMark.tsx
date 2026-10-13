/** 布局品牌标。不染色、不拉伸。壳层稍后放进顶栏、关于和总览。 */
import iconUrl from '../assets/brand-icon.png';

export function BrandMark() {
  return <img data-testid="brand-mark" alt="" src={iconUrl} width={26} height={26} draggable={false} style={{ width: 26, height: 26, objectFit: 'contain' }} />;
}
