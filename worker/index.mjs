const API_ORIGIN = 'https://aion2.plaync.com';
const SEARCH = '/api/search/character';
const DETAIL = '/api/character/daevanion/detail';
const INFO = '/api/character/info';
const json = (message, status, details = {}) => Response.json({ message, ...details }, { status, headers: { 'Cache-Control': 'no-store' } });

export function upstreamUrl(input) {
  const url = new URL(input);
  const p = url.searchParams;
  const one = name => p.getAll(name).length === 1 ? p.get(name) : null;
  const server = Number(one('serverId'));
  const race = Math.floor(server / 1000), offset = server % 1000;
  if (![1, 2].includes(race) || offset < 1 || offset > 21 || !Number.isInteger(server)) throw new Error('서버를 선택하십시오.');
  const target = new URL(url.pathname, API_ORIGIN);
  if (url.pathname === SEARCH) {
    const keyword = one('keyword')?.trim();
    const page = Number(one('page'));
    if (!keyword || keyword.length > 50 || Number(one('race')) !== race || !Number.isInteger(page) || page < 1 || page > 1000 || one('size') !== '30') throw new Error('검색 조건이 올바르지 않습니다.');
    target.search = new URLSearchParams({ keyword, race: String(race), serverId: String(server), page: String(page), size: '30' });
  } else if ([DETAIL, INFO].includes(url.pathname)) {
    const characterId = one('characterId'), boardId = Number(one('boardId'));
    if (one('lang') !== 'ko' || !/^[A-Za-z0-9_+/=-]{1,512}$/.test(characterId ?? '') || (url.pathname === DETAIL && (!Number.isSafeInteger(boardId) || boardId < 11 || boardId > 99 || ![1,2,3,4,9].includes(boardId % 10)))) throw new Error('보드 조회 조건이 올바르지 않습니다.');
    target.search = new URLSearchParams({ lang: 'ko', characterId, serverId: String(server), ...(url.pathname === DETAIL ? { boardId: String(boardId) } : {}) });
  } else throw new Error('지원하지 않는 API입니다.');
  return target;
}

export async function handleRequest(request, env, fetchUpstream = fetch) {
  const path = new URL(request.url).pathname;
  if (!path.startsWith('/api/')) return env.ASSETS.fetch(request);
  if (![SEARCH, DETAIL, INFO].includes(path)) return json('지원하지 않는 API입니다.', 404);
  if (request.method !== 'GET') return new Response(null, { status: 405, headers: { Allow: 'GET' } });
  let target;
  try { target = upstreamUrl(request.url); } catch (error) { return json(error.message, 400); }
  try {
    // No browser credentials or headers are forwarded. The upstream request
    // uses a fixed Korean locale for the allowlisted public Korean-game API routes.
    const response = await fetchUpstream(target.href, { headers: { Accept: 'application/json',
      'Accept-Language': 'ko-KR,ko;q=0.9', 'User-Agent': 'Mozilla/5.0 (compatible; DaevanionPlanner/1.0)',
      Referer: `${API_ORIGIN}/ko-kr/`, Cookie: 'country=KR; locale=ko-KR; gw_locale=ko-KR; aion2_gw_locale=ko-KR' },
      redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(12000) });
    if (!response.ok) {
      console.error('Public API upstream response:', JSON.stringify({ status: response.status,
        contentType: response.headers.get('content-type') }));
      return json(response.status === 429 ? '요청이 많습니다. 잠시 후 다시 검색하십시오.' : '공식 캐릭터 정보를 불러오지 못했습니다.', response.status === 429 ? 429 : 502,
        { upstreamStatus: response.status });
    }
    if (!response.headers.get('Content-Type')?.includes('application/json')) return json('공식 API 응답 형식이 올바르지 않습니다.', 502);
    return new Response(response.body, { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
  } catch (error) {
    console.error('Public character API request failed:', error.name, error.message);
    return json('공식 서버에 연결하지 못했습니다. 잠시 후 다시 시도하십시오.', 502);
  }
}

export default { fetch(request, env) { return handleRequest(request, env); } };
