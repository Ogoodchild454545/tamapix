"""TAMA-PIX end-to-end tests + phone screenshots (tap-only in the game UI; forms are filled like a user would).

The server owns the game now, so every flow runs against a real server:
  * main server   node server/server.js on :8765 with DEBUG=1 (time tools), a temp JSON store, relaxed rate limits
  * prod server   node on :8767 like production (NODE_ENV=production, no DEBUG, real rate limits)
  * static host   python http.server on :8768 (page without the game server -> OFFLINE message)
  * file://       the page opened as a file (-> OFFLINE message)
  * optional      PG_TEST_URL=postgres://... runs an API smoke test against Postgres on :8769
Run:  python3 test_e2e.py
"""
import asyncio, json, os, random, subprocess, sys, time, urllib.request, urllib.error, http.cookiejar
from playwright.async_api import async_playwright

ROOT = os.path.dirname(os.path.abspath(__file__))
SHOTS = os.path.join(ROOT, 'screenshots')
os.makedirs(SHOTS, exist_ok=True)
PORT, PROD_PORT, STATIC_PORT, PG_PORT = 8765, 8767, 8768, 8769
BASE = f'http://localhost:{PORT}/'
DATA = '/tmp/tama-e2e.json'
PHONE = dict(viewport={'width': 390, 'height': 844}, device_scale_factor=2, is_mobile=True, has_touch=True)
DESK = dict(viewport={'width': 800, 'height': 900})
errors, fails = [], []
HOUR = 3600e3

def check(cond, msg):
    print(('PASS ' if cond else 'FAIL ') + msg, flush=True)
    if not cond: fails.append(msg)

def start_node(port=PORT, env=None, log='/tmp/tama-node.log'):
    e = {**os.environ, 'PORT': str(port), 'DEBUG': '1', 'DATA_FILE': DATA, 'RATE_LIMIT_SCALE': '50', 'BCRYPT_COST': '4'}
    e.pop('DATABASE_URL', None); e.pop('NODE_ENV', None); e.pop('RENDER', None)
    e.update(env or {})
    e = {k: v for k, v in e.items() if v is not None}
    p = subprocess.Popen(['node', 'server/server.js'], cwd=ROOT, env=e, stdout=open(log, 'a'), stderr=subprocess.STDOUT)
    for _ in range(50):
        time.sleep(0.1)
        try: urllib.request.urlopen(f'http://localhost:{port}/healthz', timeout=1); return p
        except Exception: pass
    raise SystemExit(f'node server on :{port} failed to start (see {log})')

def start_static(port=STATIC_PORT):
    p = subprocess.Popen([sys.executable, '-m', 'http.server', str(port)], cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(0.8)
    assert p.poll() is None, 'static server failed to start (port busy?)'
    return p

def stop(p):
    if p and p.poll() is None: p.terminate(); p.wait(5)

class Http:
    """Tiny API client with its own cookie jar (for the production-like server and Postgres checks)."""
    def __init__(self, port):
        self.base = f'http://localhost:{port}'
        self.op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    def call(self, method, path, body=None, tama=True):
        h = {'content-type': 'application/json'}
        if tama: h['x-tama'] = '1'
        req = urllib.request.Request(self.base + path, method=method, headers=h, data=json.dumps(body).encode() if body is not None else None)
        try: r = self.op.open(req, timeout=10); return r.status, json.loads(r.read() or b'{}'), dict(r.headers)
        except urllib.error.HTTPError as e:
            try: d = json.loads(e.read() or b'{}')
            except Exception: d = {}
            return e.code, d, dict(e.headers)

EXPECTED_ERR = []          # substrings of console errors that a test provokes on purpose
def watch(pg, tag):
    def on_console(m):
        if m.type in ('error', 'warning') and not any(x in m.text for x in EXPECTED_ERR): errors.append(f'{tag} {m.type}: {m.text}')
    pg.on('console', on_console)
    pg.on('pageerror', lambda e: errors.append(f'{tag} pageerror: {e}'))

async def new_page(browser, opts, tag, perms=None):
    ctx = await browser.new_context(**opts)
    if perms: await ctx.grant_permissions(perms, origin=BASE[:-1])
    pg = await ctx.new_page(); watch(pg, tag); pg.touch = opts.get('has_touch', False)
    return ctx, pg

async def ev(pg, js): return await pg.evaluate(js)
async def st(pg): return await ev(pg, 'JSON.parse(JSON.stringify(Tama.Game.state))')
async def eco(pg): return await ev(pg, 'JSON.parse(JSON.stringify(Tama.Game.eco))')
async def mode(pg): return await ev(pg, 'Tama.Game.ui.mode')
async def idle(pg, ms=12000): await pg.wait_for_function('!Tama.Game.ui.anim && Tama.Game.ui.queue.length===0 && !Tama.Game.busy', timeout=ms)
async def refresh(pg): await ev(pg, 'Tama.Game.refresh()'); await pg.wait_for_timeout(120)

async def tap_icon(pg, name, wait=300):
    loc = pg.locator(f'.pbtn[data-icon="{name}"]')
    await (loc.tap() if pg.touch else loc.click()); await pg.wait_for_timeout(wait)

async def tap_zone(pg, zid, wait=450):
    """Tap the on-screen choice/zone with this id (menus, rows, HI/LO, status, pet...)."""
    c = await ev(pg, f"Tama.Game.zonePoint('{zid}')")
    if not c: raise AssertionError(f'zone {zid} not on screen (have {await ev(pg, "Tama.Game.zoneIds()")})')
    await (pg.touchscreen.tap(c['x'], c['y']) if pg.touch else pg.mouse.click(c['x'], c['y'])); await pg.wait_for_timeout(wait)

async def tap(pg, sel, wait=300):
    loc = pg.locator(sel)
    await (loc.tap() if pg.touch else loc.click()); await pg.wait_for_timeout(wait)

async def api(pg, method, path, body=None, tama=True):
    h = {'content-type': 'application/json'}
    if tama: h['x-tama'] = '1'
    return await ev(pg, f"""(async()=>{{const r=await fetch({json.dumps(path)},{{method:{json.dumps(method)},credentials:'same-origin',
        headers:{json.dumps(h)},body:{json.dumps(json.dumps(body)) if body is not None else 'undefined'}}});
        let d=null; try{{d=await r.json()}}catch(e){{}} return {{status:r.status, data:d}}}})()""")

async def dbg(pg, body, wait=150):
    ok = await ev(pg, f"Tama.Debug ? Tama.Debug.op({json.dumps(body)}) : Tama.Api.post('/api/debug', {json.dumps(body)}).then(r => (r.data.state && Tama.Game.applyView(r.data.state), r.status === 200))")
    await pg.wait_for_timeout(wait); return ok

async def make_pet(pg, form='nekoru', name='PIPO', pet=None, eco_=None):
    """Hatch/force the pet into `form` on the server, healthy and full of energy."""
    if (await st(pg))['stage'] == 'egg': await dbg(pg, {'op': 'hatch'})
    await dbg(pg, {'op': 'force', 'form': form})
    age = await ev(pg, f"(Tama.Evolution.entryAge('{form}') || 0) + 60000")
    p = dict(name=name, hunger=4, happy=4, poops=[], sick=False, dead=False, energy=100, asleep=False, napping=False, lightsOff=False, fakeCall=False, job=None, ageMs=age)
    p.update(pet or {})
    await dbg(pg, {'op': 'patch', 'pet': p, 'eco': eco_ or {}})
    await ev(pg, "Tama.Game.resetUI(); Tama.Game.ui.anim=null; Tama.Game.ui.queue=[]; Tama.Game.ui.toast=null")
    await pg.wait_for_timeout(200)

async def signup(pg, user, pw='secret123', year=None, adult=False):
    await pg.wait_for_selector('#authPanel:not([hidden])', timeout=8000)
    await tap(pg, '#tabSignup', 100)
    await pg.fill('#authUser', user); await pg.fill('#authPass', pw)
    if year: await pg.fill('#authYear', str(year))
    if adult: await pg.check('#authAdult')
    await tap(pg, '#authGo', 200)
    await pg.wait_for_function('Tama.Game.session', timeout=8000); await idle(pg)

async def login(pg, user, pw='secret123'):
    await pg.wait_for_selector('#authPanel:not([hidden])', timeout=8000)
    await tap(pg, '#tabLogin', 100)
    await pg.fill('#authUser', user); await pg.fill('#authPass', pw)
    await tap(pg, '#authGo', 200)
    await pg.wait_for_function('Tama.Game.session', timeout=8000); await idle(pg)

async def fight_by_tapping(pages, shot=None, max_s=120):
    """Tap HI/LO on every page that's waiting for a move, until no page is in a battle."""
    t0 = time.time(); shot_done = False
    while time.time() - t0 < max_s:
        busy = False
        for pg in pages:
            info = await ev(pg, "(function(){var B=Tama.Game.ui.battle, s=Tama.Game.ui.search; return B?{p:B.phase,k:B.kind}:(s?{p:'search'}:null)})()")
            if info is None: continue
            busy = True
            if info['p'] == 'choose':
                if not await ev(pg, "!!Tama.Game.zonePoint('hi')"): continue
                await tap_zone(pg, random.choice(['hi', 'lo']), wait=120)
            elif shot and not shot_done and info['p'] == 'anim' and pg is pages[0]:
                await pg.wait_for_timeout(420); await pg.screenshot(path=shot); shot_done = True
        if not busy: return True
        await asyncio.sleep(0.12)
    return False

async def shot(pg, name, wait=250):
    await pg.wait_for_timeout(wait); await pg.screenshot(path=f'{SHOTS}/{name}.png')

async def main():
    for f in os.listdir(SHOTS):
        if f.endswith('.png'): os.remove(os.path.join(SHOTS, f))
    for f in (DATA, DATA + '.tmp', '/tmp/tama-e2e-prod.json'):
        if os.path.exists(f): os.remove(f)
    open('/tmp/tama-node.log', 'w').close()
    node = start_node()
    async with async_playwright() as p:
        browser = await p.chromium.launch()

        # ================= 1. log in screen, sign-up, phone layout =================
        ctxA, A = await new_page(browser, PHONE, 'A', perms=['notifications'])
        await A.goto(BASE)
        await A.wait_for_selector('#authPanel:not([hidden])', timeout=8000)
        check(True, 'logged out: the log-in / sign-up sheet is shown')
        check(await ev(A, "document.getElementById('guestGo').offsetHeight >= 44 && document.getElementById('authGo').offsetHeight >= 44"), 'log-in buttons are big tap targets')
        check(await ev(A, "document.getElementById('ephemeralNote').hidden"), 'no "test server" warning when running locally with a file store')
        await shot(A, '01-phone-login')
        await tap(A, '#tabSignup', 100)
        await A.fill('#authUser', 'al'); await A.fill('#authPass', 'secret123'); await tap(A, '#authGo')
        check('3-16' in await A.inner_text('#authError'), 'sign-up rejects a too-short username')
        await A.fill('#authUser', 'alice'); await A.fill('#authPass', 'short'); await tap(A, '#authGo')
        check('8 characters' in await A.inner_text('#authError'), 'sign-up rejects a short password')
        await A.fill('#authPass', 'secret123'); await A.fill('#authYear', '1990'); await A.check('#authAdult'); await tap(A, '#authGo', 300)
        await A.wait_for_function('Tama.Game.session', timeout=8000)
        u = await ev(A, 'Tama.Game.user')
        check(u['username'] == 'alice' and not u['isGuest'] and u['birthYear'] == 1990 and u['adult'] is True and u['friendCode'].startswith('PX-'),
              f'sign-up creates the account (birth year + adult flag stored, friend code {u["friendCode"]})')
        cookies = {c['name']: c for c in await ctxA.cookies()}
        check('tp_sid' in cookies and cookies['tp_sid']['httpOnly'] and cookies['tp_sid']['sameSite'] == 'Lax' and 'tp_sid' not in await ev(A, 'document.cookie'),
              'session cookie is httpOnly + SameSite=Lax (invisible to page scripts)')
        await idle(A)
        e0 = await eco(A)
        check(e0['coins'] == 10 and e0['gift']['idx'] == 1, f"daily login gift day 1 = 10 coins ({e0['coins']})")
        s0 = await st(A)
        check(s0['stage'] == 'egg' and s0['energy'] == 100, 'a new account starts with an egg and full energy')
        sizes = await ev(A, "[...document.querySelectorAll('button.pbtn')].map(e=>{const r=e.getBoundingClientRect();return [e.dataset.icon, r.width, r.height]})")
        check(len(sizes) == 11 and all(w >= 44 and h >= 44 for _, w, h in sizes), f'11 HUD buttons, all >= 44px ({[n for n, _, _ in sizes]})')
        check(await ev(A, "document.documentElement.scrollWidth <= 390 && document.documentElement.scrollHeight <= 844"), 'no scrolling on a 390x844 phone')
        cov = await ev(A, "(function(){var r=document.getElementById('scene').getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom]})()")
        check(cov[0] <= 0 and cov[1] <= 0 and cov[2] >= 390 and cov[3] >= 844, 'scene fills the phone screen')
        wal = await ev(A, "(function(){var w=document.getElementById('wallet').getBoundingClientRect(), t=document.getElementById('barTop').getBoundingClientRect(), s=Tama.Game.stageToClient(0,-20); return [w.top>=t.bottom-1, w.bottom<=s.y, getComputedStyle(document.getElementById('wallet')).visibility]})()")
        check(wal[0] and wal[1] and wal[2] == 'visible', f'energy/coins strip sits under the top bar, above the play area {wal}')
        disabled = await ev(A, "[...document.querySelectorAll('button.pbtn')].filter(b=>b.disabled).map(b=>b.dataset.icon)")
        check(set(disabled) == {'feed', 'light', 'play', 'medicine', 'bath', 'discipline', 'battle', 'back'}, f'egg: care buttons disabled, HOME/STATUS/BELL usable ({disabled})')

        # hatch (server clock) -> BLOB
        await dbg(A, {'op': 'hatch'}); await A.wait_for_function("Tama.Game.state.stage==='baby'", timeout=5000); await idle(A)
        s = await st(A)
        check(s['formId'] == 'blob' and s['xp'] == 0, 'the server hatches every egg as the BLOB (Lv 1)')

        # ================= 2. care loop by tapping (server-validated) =================
        h0 = s['hunger']
        await dbg(A, {'op': 'patch', 'pet': {'hunger': 1}})
        await tap_icon(A, 'feed'); check(await mode(A) == 'feedMenu', 'FEED opens meal/snack')
        await tap_zone(A, 'meal'); await idle(A)
        s = await st(A); check(s['hunger'] == 2, 'MEAL: the server adds a hunger heart')
        check(s['energy'] == 100, 'on-time care earn-back never goes over max energy')
        await tap_icon(A, 'feed'); await tap_zone(A, 'snack'); await idle(A)
        check((await st(A))['snacks'] == 1, 'SNACK recorded by the server')
        await tap_icon(A, 'feed'); await tap_icon(A, 'back'); check(await mode(A) == 'main', 'BACK leaves the feed menu')

        en0 = (await st(A))['energy']
        await tap_icon(A, 'play', 600); check(await mode(A) == 'play', 'TRAIN starts the left/right game (server session)')
        for i in range(5):
            await A.wait_for_function("Tama.Game.ui.play && Tama.Game.ui.play.phase==='wait'", timeout=6000)
            await tap_zone(A, 'left' if i % 2 else 'right', wait=60)
            await A.wait_for_function("!Tama.Game.ui.play || Tama.Game.ui.play.phase!=='wait' && Tama.Game.ui.play.phase!=='sending'", timeout=5000)
        await A.wait_for_function("Tama.Game.ui.mode==='main'", timeout=9000)
        s = await st(A)
        check(s['training'] == 1 and s['xp'] > 0, f"training finished by tapping: server gave {s['xp']} XP")
        check(abs(s['energy'] - (en0 - 10)) < 0.5, f"training costs 10 energy ({en0:.0f} -> {s['energy']:.0f})")

        await dbg(A, {'op': 'sick'}); await dbg(A, {'op': 'patch', 'pet': {'doses': 1}})
        await tap_icon(A, 'medicine'); await idle(A); check(not (await st(A))['sick'], 'MEDICINE cures (server)')
        await dbg(A, {'op': 'poop'}); await tap_icon(A, 'bath'); await idle(A); check(len((await st(A))['poops']) == 0, 'CLEAN removes the poop (server)')

        # discipline "!" screen: purpose + feedback
        await tap_icon(A, 'discipline'); check(await mode(A) == 'discipline', '"!" opens the DISCIPLINE screen')
        await dbg(A, {'op': 'fake'})
        await shot(A, '09-phone-discipline-screen', 400)
        await tap_zone(A, 'scold'); await idle(A)
        s = await st(A); msg = await ev(A, 'Tama.Game.ui.discMsg')
        check(s['discipline'] == 25 and 'Obedience 0% > 25%' in msg, f'SCOLD during a fake call: +25% obedience with feedback ("{msg}")')
        hp0 = s['happy']
        await tap_zone(A, 'scold'); await idle(A)
        s = await st(A); msg = await ev(A, 'Tama.Game.ui.discMsg')
        check(s['happy'] == max(0, hp0 - 1) and 'unfair' in msg, f'SCOLD when it behaves: mood -1 and it says so ("{msg}")')
        await tap_zone(A, 'discBack'); check(await mode(A) == 'main', 'discipline BACK button works')

        # lights: sleep only via lights off (or exhaustion); no clock-based sleep
        await tap_icon(A, 'light'); await tap_zone(A, 'lightsOff'); await idle(A)
        s = await st(A); check(s['asleep'] and s['lightsOff'] and not s['napping'], 'LIGHTS OFF puts it to sleep')
        check(await ev(A, "document.body.dataset.env") == 'night', 'lights off = night meadow')
        await dbg(A, {'op': 'patch', 'pet': {'energy': 40}}); await dbg(A, {'op': 'skip', 'ms': 2 * HOUR})
        s = await st(A); check(68 <= s['energy'] <= 71, f"sleeping with lights off recharges ~15 energy/h (40 -> {s['energy']:.1f} in 2 h)")
        check('+' in await A.inner_text('#energyNum'), 'the energy strip shows "+" while recharging')
        await tap_icon(A, 'feed', 1600)
        check(await mode(A) == 'main' and 'asleep' in (await ev(A, "(Tama.Game.ui.toast||{}).l1") or ''), 'FEED while asleep: refused with a clear message')
        await tap_icon(A, 'light'); await tap_zone(A, 'lightsOn'); await idle(A)
        check(not (await st(A))['asleep'], 'LIGHTS ON wakes it')
        night = await ev(A, """(function(){var s=Tama.Pet.create(); s.eggMs=Tama.CONFIG.T.HATCH; Tama.Pet.simulate(s,1000); s.tz='UTC';
            s.createdAt=Date.UTC(2026,0,1,22,0,0)-s.ageMs-s.eggMs; Tama.Pet.simulate(s, 3*3600e3); return [s.asleep, s.energy]})()""")
        check(night[0] is False and night[1] == 100, f'no bedtime: awake at 23:00-01:00 on its clock, energy is not drained by time ({night})')
        nap = await ev(A, """(function(){var s=Tama.Pet.create(); s.eggMs=Tama.CONFIG.T.HATCH; Tama.Pet.simulate(s,1000); s.energy=0; Tama.Pet.simulate(s, 60000);
            var a=[s.asleep, s.napping]; Tama.Pet.simulate(s, 4*3600e3); var b=s.asleep; Tama.Pet.simulate(s, 1.5*3600e3); return a.concat([b, s.asleep, Math.round(s.energy)])})()""")
        check(nap[0] and nap[1] and nap[2] and not nap[3] and nap[4] >= 40, f'energy 0: it naps (+8/h) and wakes by itself at 40 ({nap})')
        evo = await ev(A, """(function(){var s=Tama.Pet.create(); s.eggMs=Tama.CONFIG.T.HATCH; Tama.Pet.simulate(s,1000); s.tz='UTC'; s.hunger=4; s.happy=4;
            s.ageMs=Tama.CONFIG.T.TEEN_AT-30000; s.createdAt=Date.UTC(2026,0,1,23,30,0)-s.ageMs-s.eggMs; Tama.Pet.simulate(s,60000); return [s.stage, s.asleep]})()""")
        check(evo == ['teen', False], f'evolution happens on time at night too (no waiting for morning) ({evo})')

        # status pages (energy + wallet + level cap)
        await tap_icon(A, 'status'); pages = []
        for _ in range(5): pages.append(await ev(A, 'Tama.Game.ui.page')); await tap_zone(A, 'status', 250)
        check(pages == [0, 1, 2, 3, 4] and await mode(A) == 'main', f'STATUS pages PROFILE/CARE/ENERGY/WALLET/RECORD {pages}')

        # ================= 3. the bell: badge for the most urgent issue + attention panel =================
        await make_pet(A, 'nekoru', 'PIPO', pet={'hunger': 0, 'xp': 200}, eco_={'coins': 240})
        await dbg(A, {'op': 'poop'}); await dbg(A, {'op': 'sick'})
        await A.wait_for_timeout(300)
        bell = await ev(A, """(function(){var b=document.querySelector('.pbtn.bell'), g=b.querySelector('.badge');
            return {alert:b.classList.contains('alert'), urgent:b.classList.contains('urgent'), hidden:g.hidden, top:g.dataset.top, count:g.querySelector('b').textContent, label:b.getAttribute('aria-label')}})()""")
        check(bell['alert'] and bell['urgent'] and not bell['hidden'] and bell['top'] == 'sick' and bell['count'] == '3',
              f"bell lights up with the most urgent issue's icon (sick) and a count of 3 ({bell['top']}, {bell['count']})")
        check('Sick' in bell['label'] and 'Starving' in bell['label'], 'bell has an accessible label listing the issues')
        await ev(A, "var u=Tama.Game.ui; u.pet.x=24; u.pet.move='stay'; u.nextThink=performance.now()+1e9;")
        await shot(A, '10-phone-bell-badge', 500)
        await tap_icon(A, 'attention')
        items = await ev(A, "[...document.querySelectorAll('#attnList li')].map(l=>l.dataset.item)")
        check(await ev(A, "!document.getElementById('attnPanel').hidden") and items == ['sick', 'hungry', 'poop'], f'tapping the bell opens the attention panel, most urgent first {items}')
        await shot(A, '08-phone-attention-panel', 300)
        await tap(A, '[data-action="sick:medicine"]', 300); await idle(A)
        await dbg(A, {'op': 'patch', 'pet': {'doses': 0}})
        s = await st(A)
        await tap_icon(A, 'attention'); await tap(A, '[data-action="hungry:feed"]', 300); await idle(A)
        check((await st(A))['hunger'] == 1, 'quick action FEED from the panel feeds a meal')
        await tap_icon(A, 'attention'); await tap(A, '[data-action="poop:clean"]', 300); await idle(A)
        check(len((await st(A))['poops']) == 0, 'quick action CLEAN from the panel cleans')
        await dbg(A, {'op': 'patch', 'pet': {'sick': False, 'hunger': 4, 'happy': 4, 'energy': 12}})
        await A.wait_for_timeout(200)
        check(await ev(A, "document.querySelector('.pbtn.bell .badge').dataset.top") == 'tired', 'low energy shows the energy badge on the bell')
        await tap_icon(A, 'attention'); await tap(A, '[data-action="tired:sleep"]', 300); await idle(A)
        check((await st(A))['asleep'], 'quick action SLEEP from the panel turns the lights off')
        await dbg(A, {'op': 'patch', 'pet': {'asleep': False, 'lightsOff': False, 'energy': 100}})
        await tap_icon(A, 'attention')
        check(await ev(A, "!document.getElementById('attnEmpty').hidden && document.querySelectorAll('#attnList li').length===0"), 'nothing wrong: the panel says "All good"')
        await tap(A, '#attnClose')
        age0 = (await st(A))['ageMs']
        await dbg(A, {'op': 'patch', 'pet': {'ageMs': await ev(A, "Tama.Evolution.nextAgeAt(Tama.Game.state)") - 2 * HOUR}})
        items = await ev(A, "Tama.Game.attentionItems().map(i=>i.id)")
        check('evolve' in items, f'bell warns when an evolution is less than 3 h away {items}')
        await dbg(A, {'op': 'patch', 'pet': {'ageMs': age0}})

        # ================= 4. energy: out of energy panel (free options only) =================
        await dbg(A, {'op': 'patch', 'pet': {'energy': 5, 'hunger': 4, 'happy': 4, 'poops': []}})
        await tap_icon(A, 'play', 600)
        c = await ev(A, "Tama.Game.ui.confirm && {id:Tama.Game.ui.confirm.id, lines:Tama.Game.ui.confirm.lines.join(' '), yes:Tama.Game.ui.confirm.yes.label}")
        check(c and c['id'] == 'tired' and 'lights off' in c['lines'] and 'FIZZ' not in c['lines'].upper() and 'shop' not in c['lines'].lower(),
              f'not enough energy: TOO TIRED panel with free options only, no upsell ({c})')
        await shot(A, '11-phone-out-of-energy', 200)
        await tap_zone(A, 'tiredYes'); await idle(A)
        check((await st(A))['asleep'], 'TOO TIRED -> SLEEP turns the lights off')
        await dbg(A, {'op': 'patch', 'pet': {'asleep': False, 'lightsOff': False, 'energy': 100}})

        # ================= 5. main menu hub + every menu row =================
        await tap_icon(A, 'home'); check(await mode(A) == 'menu', 'HOME opens the MAIN MENU')
        ids = await ev(A, "Tama.Game.zoneIds()")
        check(all(z in ids for z in ['mMeadow', 'mBattle', 'mJobs', 'mShop', 'mStatus', 'mHelp', 'mSettings']), f'menu: Meadow, Battle, Jobs, Shop, Status, Help, Settings')
        await shot(A, '06-phone-main-menu')
        await tap_zone(A, 'mMeadow'); check(await mode(A) == 'main', 'menu MEADOW returns to the meadow')
        await tap_icon(A, 'home'); await tap_zone(A, 'mBattle'); check(await mode(A) == 'battleMenu', 'menu BATTLE opens the battle menu')
        await tap_icon(A, 'back'); check(await mode(A) == 'menu', 'BACK from a menu screen returns to the menu')
        await tap_zone(A, 'mStatus'); check(await mode(A) == 'status', 'menu STATUS'); await tap_icon(A, 'back')
        await tap_icon(A, 'home'); await tap_zone(A, 'mHelp'); check(await mode(A) == 'help', 'menu HELP opens the help pages')
        await shot(A, '12-phone-help')
        hp = []
        for _ in range(6): hp.append(await ev(A, 'Tama.Game.ui.page')); await tap_zone(A, 'help', 200)
        check(hp == [0, 1, 2, 3, 4, 5] and await mode(A) == 'menu', f'help has 6 pages (care, energy, coins, jobs, shop, XP) {hp}')
        await tap_zone(A, 'mSettings'); check(await mode(A) == 'settings', 'menu SETTINGS')
        m0 = await ev(A, 'Tama.Audio.muted'); await tap_zone(A, 'sSound'); check(await ev(A, 'Tama.Audio.muted') != m0, 'settings SOUND toggles sound')
        await tap_zone(A, 'sSound')
        # headless Chromium always reports "denied", so stand in for the browser's permission prompt
        await ev(A, "window.__N=window.Notification; window.Notification=function(t,o){return {close(){}}}; window.Notification.permission='default'; window.Notification.requestPermission=()=>{window.Notification.permission='granted'; return Promise.resolve('granted')}")
        await tap_zone(A, 'sNotify', 600)
        check(await ev(A, "Tama.Game.Notify.label()") == 'ON', 'settings ALERTS asks permission and turns browser notifications on')
        await shot(A, '13-phone-settings')
        await tap_zone(A, 'sAccount'); check(await ev(A, "!document.getElementById('accountPanel').hidden") and 'alice' in await A.inner_text('#accWho'), 'settings ACCOUNT opens the account sheet')
        check(await ev(A, "document.getElementById('upgradeForm').hidden"), 'no "save as account" form for a real account')
        await tap(A, '#accClose')
        await tap_zone(A, 'sLogout'); check(await ev(A, "Tama.Game.ui.confirm && Tama.Game.ui.confirm.id") == 'logout', 'settings LOG OUT asks first')
        await tap_zone(A, 'logoutNo'); check(await ev(A, 'Tama.Game.session') and not await ev(A, 'Tama.Game.ui.confirm'), 'cancel keeps you logged in')
        await tap_icon(A, 'back'); await tap_icon(A, 'back')

        # ================= 6. shop: Fizz cap, food, tools; coins =================
        await make_pet(A, 'nekoru', 'PIPO', pet={'energy': 10, 'xp': 200}, eco_={'coins': 500})
        await tap_icon(A, 'home'); await tap_zone(A, 'mShop'); check(await mode(A) == 'shop', 'menu SHOP')
        await shot(A, '04-phone-shop')
        for i in range(3):
            await tap_zone(A, 'buy_fizz'); await tap_zone(A, 'buyYes'); await idle(A)
        s, e = await st(A), await eco(A)
        check(s['energy'] == 100 and e['coins'] == 320 and e['daily']['drinks'] == 3, f"3 Fizz: +30 energy each (capped at 100), 60 coins each ({s['energy']}, {e['coins']}c)")
        await dbg(A, {'op': 'patch', 'pet': {'energy': 10}})
        await tap_zone(A, 'buy_fizz', 300)
        check('Enough fizz' in (await ev(A, "(Tama.Game.ui.toast||{}).l1") or '') and not await ev(A, 'Tama.Game.ui.confirm'), 'the 4th Fizz of the day is refused (no upsell)')
        r = await api(A, 'POST', '/api/act', {'type': 'buy', 'sku': 'fizz'})
        check(r['data']['ok'] is False and r['data']['error'] == 'cap' and (await eco(A))['coins'] == 320, 'edited request for a 4th Fizz is rejected by the server')
        await dbg(A, {'op': 'patch', 'pet': {'hunger': 1}})
        await tap_zone(A, 'buy_stew'); await tap_zone(A, 'buyYes'); await idle(A)
        check((await st(A))['hunger'] == 3 and (await eco(A))['coins'] == 308, 'HEARTY STEW: +2 hunger for 12 coins')
        await tap_icon(A, 'home'); await tap_zone(A, 'mShop')
        await tap_zone(A, 'buy_pick3', 300)
        await tap_zone(A, 'buyNo') if await ev(A, '!!Tama.Game.ui.confirm') else None
        r = await api(A, 'POST', '/api/act', {'type': 'buy', 'sku': 'pick3'})
        check(r['data']['ok'] is False and r['data']['error'] in ('needs', 'coins'), f"edited request: PICKAXE III without II/coins is rejected ({r['data']['error']})")
        await dbg(A, {'op': 'patch', 'eco': {'coins': 3}})
        r = await api(A, 'POST', '/api/act', {'type': 'buy', 'sku': 'stew'})
        check(r['data']['ok'] is False and r['data']['error'] == 'coins', 'buying without enough coins is rejected')
        chk = await ev(A, "Tama.Economy.freeMoneyCheck()")
        check(chk['ok'] and chk['best'] < chk['drink'], f"coins per energy from work ({chk['best']}) stay below the Fizz price per energy ({chk['drink']})")
        await tap_icon(A, 'back')

        # ================= 7. Pix Town Jobs: start, away, finish, pay, recall, locks =================
        await make_pet(A, 'blob', 'PIPO', eco_={'coins': 100})
        await tap_icon(A, 'home'); await tap_zone(A, 'mJobs'); check(await mode(A) == 'jobs' and await ev(A, "document.body.dataset.env") == 'mine', 'menu PIX TOWN JOBS opens the mine scene')
        ids = await ev(A, "Tama.Game.zoneIds()")
        check('go_tidy' in ids and 'go_cart' not in ids and 'go_smelter' not in ids, f'baby: only TIDY-UP is open; mine jobs locked ({[i for i in ids if i.startswith("go_")]})')
        r = await api(A, 'POST', '/api/act', {'type': 'job_start', 'id': 'smelter'})
        check(r['data']['ok'] is False and r['data']['error'] == 'locked', 'edited request for a locked job is rejected')
        await make_pet(A, 'nekoru', 'PIPO', pet={'hunger': 4}, eco_={'coins': 100})
        await tap_icon(A, 'home'); await tap_zone(A, 'mJobs')
        await shot(A, '05-phone-jobs-mine')
        await tap_zone(A, 'go_cart'); check(await ev(A, "Tama.Game.ui.confirm.id") == 'job', 'GO asks to confirm (duration, energy, pay)')
        await tap_zone(A, 'jobYes'); await idle(A)
        s = await st(A)
        check(s['job'] and s['job']['id'] == 'cart' and s['energy'] == 80, f"ORE CART started: pet away, -20 energy ({s['energy']})")
        await ev(A, "Tama.Game.ui.toast=null")
        await shot(A, '05b-phone-job-in-progress', 900)
        await tap_icon(A, 'back'); await tap_icon(A, 'back')
        check(await ev(A, "Tama.Game.zoneIds().includes('away')") and 'pet' not in await ev(A, "Tama.Game.zoneIds()"), 'the meadow is empty with an "away at work" sign')
        await tap_icon(A, 'feed', 300)
        check('Away at work' in (await ev(A, "(Tama.Game.ui.toast||{}).l1") or ''), 'care while working: clear "away at work" message')
        r = await api(A, 'POST', '/api/act', {'type': 'feed'})
        check(r['data']['error'] == 'working', 'server refuses care while the pet is at work')
        hungerT0 = (await st(A))['hungerT']
        await dbg(A, {'op': 'skip', 'ms': 20 * 60e3})
        await dbg(A, {'op': 'finish_job'}); await idle(A)
        s, e = await st(A), await eco(A)
        check(s['job'] is None and e['coins'] == 125 and e['inventory']['ore'] == 1, f"job done: +25 coins, +1 ore ({e['coins']}c, ore {e['inventory']['ore']})")
        check(await ev(A, "document.querySelector('.pbtn.bell .badge').dataset.top") == 'jobDone', 'bell shows the job-done badge')
        await tap_icon(A, 'attention'); await tap(A, '[data-action="jobDone:ok"]', 400); await idle(A)
        check((await eco(A))['lastJob']['seen'], 'job-done quick action clears it')
        await tap_icon(A, 'home'); await tap_zone(A, 'mJobs'); await tap_zone(A, 'go_tidy'); await tap_zone(A, 'jobYes'); await idle(A)
        await tap_zone(A, 'recall'); await tap_zone(A, 'recallYes'); await idle(A)
        check((await st(A))['job'] is None and (await eco(A))['coins'] == 125, 'RECALL brings it home early with no pay')
        await tap_icon(A, 'back')
        work = await ev(A, """(function(){var a=Tama.Pet.create(), b; a.eggMs=Tama.CONFIG.T.HATCH; Tama.Pet.simulate(a,1000); a.hunger=4; a.happy=4; b=JSON.parse(JSON.stringify(a));
            b.job={id:'deep',name:'DEEP SHIFT',startT:b.simT,endT:b.simT+8*3600e3,pay:60,ore:2}; Tama.Pet.simulate(a, 5400e3); Tama.Pet.simulate(b, 5400e3);
            return [a.hunger, b.hunger, b.asleep]})()""")
        check(work[1] < work[0] and work[2] is False, f'hunger drops faster at work, and it never sleeps on the job ({work})')

        # ================= 8. CPU battle (server-run) =================
        await make_pet(A, 'nekoru', 'ALICE', pet={'xp': 400}, eco_={'coins': 125})
        b0, en0 = (await st(A))['battles'], (await st(A))['energy']
        await tap_icon(A, 'battle'); check(await mode(A) == 'battleMenu', 'BATTLE opens RANDOM / CPU / FRIEND / CHALLENGE')
        await shot(A, '14-phone-battle-menu')
        await tap_zone(A, 'bCpu', 600)
        await A.wait_for_function("Tama.Game.ui.battle && Tama.Game.ui.battle.kind==='cpu'", timeout=6000)
        check(True, 'VS COMPUTER starts a server battle')
        check(await fight_by_tapping([A], shot=f'{SHOTS}/15-phone-cpu-battle.png'), 'CPU battle played to the end by tapping HI/LO')
        await A.wait_for_function("Tama.Game.ui.mode==='main'", timeout=8000); await refresh(A)
        s = await st(A)
        check(s['battles'] == b0 + 1 and abs(s['energy'] - (en0 - 6)) < 0.5, f"CPU battle recorded, cost 6 energy ({en0:.0f} -> {s['energy']:.0f})")

        # ================= 9. second account: random online, friend code, challenges =================
        ctxB, B = await new_page(browser, PHONE, 'B', perms=['notifications'])
        await B.goto(BASE); await signup(B, 'bob')
        await make_pet(B, 'scrapper', 'BOB', pet={'xp': 300})
        await make_pet(A, 'nekoru', 'ALICE', pet={'xp': 400})
        sa0, sb0 = await st(A), await st(B)
        ca0, cb0 = (await eco(A))['daily']['battleCoins'], (await eco(B))['daily']['battleCoins']
        await tap_icon(A, 'battle'); await tap_zone(A, 'bRandom', 500)
        check(await mode(A) == 'search', 'RANDOM ONLINE starts searching')
        await shot(A, '16-phone-searching', 900)
        await tap_icon(B, 'battle'); await tap_zone(B, 'bRandom', 500)
        await A.wait_for_function("Tama.Game.ui.battle && Tama.Game.ui.battle.kind==='online'", timeout=8000)
        await B.wait_for_function("Tama.Game.ui.battle && Tama.Game.ui.battle.kind==='online'", timeout=8000)
        oa, ob = await ev(A, "Tama.Game.ui.battle.opp.card"), await ev(B, "Tama.Game.ui.battle.opp.card")
        check(oa['name'] == 'BOB' and oa['formId'] == 'scrapper' and ob['name'] == 'ALICE', 'two accounts matched online, each sees the other\'s server-held pet')
        r = await api(A, 'POST', '/api/act', {'type': 'feed'})
        check(r['data'].get('ok') is False and r['data'].get('error') == 'battle', f"care actions are refused during a battle ({r})")
        await A.wait_for_function("Tama.Game.ui.battle.phase==='choose'", timeout=9000)
        await shot(A, '17-phone-online-battle', 500)
        check(await fight_by_tapping([A, B]), 'online battle finished (both players tapping)')
        await refresh(A); await refresh(B)
        sa, sb = await st(A), await st(B)
        check(sa['battles'] == sa0['battles'] + 1 and sb['battles'] == sb0['battles'] + 1 and (sa['wins'] - sa0['wins']) + (sb['wins'] - sb0['wins']) == 1,
              'both pets recorded the battle, exactly one winner')
        ea, eb = await eco(A), await eco(B)
        da, db = ea['daily']['battleCoins'] - ca0, eb['daily']['battleCoins'] - cb0
        check(sorted([da, db]) == [4, 12], f"online coins: win 12, loss 4 ({da}, {db})")

        # friend code: ghost battle vs the stored pet
        bcode = (await ev(B, 'Tama.Game.user'))['friendCode']
        await tap_icon(A, 'battle'); await tap_zone(A, 'bFriend')
        check(await ev(A, "!document.getElementById('linkPanel').hidden") and await A.inner_text('#myCode') == (await ev(A, 'Tama.Game.user'))['friendCode'],
              'FRIEND CODE sheet shows your server friend code')
        await A.fill('#friendCode', 'TP-eyJuIjoiUElQTyIsImYiOiJuZWtvcnUifQ'); await tap(A, '#linkFight')
        check('Old codes' in await A.inner_text('#linkError'), 'old TP- codes get a clear "ask for the new code" message')
        await A.fill('#friendCode', 'hello'); await tap(A, '#linkFight')
        check('PX-' in await A.inner_text('#linkError'), 'a malformed code shows the expected format')
        await A.fill('#friendCode', bcode.lower()); await tap(A, '#linkFight', 600)
        await A.wait_for_function("Tama.Game.ui.battle && Tama.Game.ui.battle.kind==='friend'", timeout=6000)
        opp = await ev(A, "Tama.Game.ui.battle")
        check(opp['opp']['card']['name'] == 'BOB' and opp['ghost'], 'friend code battle vs BOB\'s server-held pet (computer-controlled)')
        await A.wait_for_function("Tama.Game.ui.battle.phase==='choose'", timeout=8000)
        await tap_icon(A, 'back', 300)
        check(await ev(A, "Tama.Game.ui.battle && Tama.Game.ui.battle.reason") == 'fled', 'BACK flees a battle')
        await A.wait_for_function("Tama.Game.ui.mode==='main'", timeout=6000)

        # challenge (both online): live on the bell, browser notification, accept -> live battle
        await ev(B, "Object.defineProperty(document, 'hasFocus', {value: () => false, configurable: true})")   # B looks at another tab
        await ev(B, "window.__notes=[]; const N=window.Notification; window.Notification=function(t,o){window.__notes.push(o.body); return {close(){}}}; window.Notification.permission='granted'; window.Notification.requestPermission=()=>Promise.resolve('granted'); localStorage.setItem('tamapix.notify','1')")
        await tap_icon(A, 'battle'); await tap_zone(A, 'bChallenge')
        check(await ev(A, "!document.getElementById('challengePanel').hidden"), 'CHALLENGE opens the challenge sheet')
        await A.fill('#chTarget', 'nobody_here'); await tap(A, '#chSend', 500)
        check('No player' in await A.inner_text('#chError'), 'challenging an unknown player shows an error')
        await A.fill('#chTarget', 'alice'); await tap(A, '#chSend', 500)
        check('yourself' in await A.inner_text('#chError'), "you can't challenge yourself")
        await A.fill('#chTarget', 'bob'); await tap(A, '#chSend', 600)
        check('sent to bob (online now)' in await A.inner_text('#chError'), 'challenge sent by username (bob is online)')
        await B.wait_for_function("Tama.Game.challenges.incoming.length===1", timeout=5000)
        await B.wait_for_timeout(300)
        bb = await ev(B, "document.querySelector('.pbtn.bell .badge').dataset.top")
        check(bb == 'challenge', 'the challenged player sees it live on the bell (challenge badge)')
        notes = await ev(B, 'window.__notes')
        check(any('alice challenged you' in n for n in notes), f'a browser notification is shown for the challenge {notes}')
        await shot(B, '18-phone-challenge-notification', 200)
        await tap_icon(B, 'attention')
        check('alice challenged you to a fight!' in await B.inner_text('#attnList'), 'attention panel lists the challenge with Accept / Decline')
        await shot(B, '18b-phone-challenge-panel', 200)
        await tap(A, '#chClose')
        await tap(B, '[data-action="challenge:acc"]', 600)
        await A.wait_for_function("Tama.Game.ui.battle && Tama.Game.ui.battle.live", timeout=8000)
        await B.wait_for_function("Tama.Game.ui.battle && Tama.Game.ui.battle.live", timeout=8000)
        check(True, 'accepting while both are online starts a LIVE battle for both players')
        check(await fight_by_tapping([A, B]), 'live challenge battle finished')
        await A.wait_for_timeout(600); await refresh(A)
        outg = (await ev(A, 'Tama.Game.challenges'))['outgoing']
        check(outg and outg[0]['status'] == 'done' and 'won' in (outg[0]['result'] or ''), f'the challenge is recorded as done ({outg[0] if outg else None})')

        # decline
        await ev(A, "Tama.Game.toast('', '', 1)")
        r = await api(A, 'POST', '/api/challenge', {'target': bcode})
        check(r['data']['ok'] and r['data']['online'], 'challenge by friend code works too')
        await B.wait_for_function("Tama.Game.challenges.incoming.length===1", timeout=5000)
        await tap_icon(B, 'attention'); await tap(B, '[data-action="challenge:dec"]', 600)
        await A.wait_for_function("(Tama.Game.ui.toast||{}).l1 && Tama.Game.ui.toast.l1.indexOf('declined')>=0", timeout=5000)
        check(True, 'DECLINE notifies the challenger live')

        # offline challenge: stored server-side, shown on next login; accepting fights the stored pet
        await ctxB.close()
        await A.wait_for_timeout(300)
        r = await api(A, 'POST', '/api/challenge', {'target': 'bob'})
        check(r['data']['ok'] and not r['data']['online'], 'challenging an offline player stores it on the server')
        await ctxA.close()                                    # the challenger goes offline too
        ctxB, B = await new_page(browser, PHONE, 'B2'); await B.goto(BASE); await login(B, 'bob')
        await B.wait_for_timeout(400)
        inc = await ev(B, "Tama.Game.challenges.incoming")
        check(len(inc) == 1 and inc[0]['from'] == 'alice' and not inc[0]['online'], 'on next login the stored challenge is on the bell')
        await tap_icon(B, 'attention')
        check('Offline' in await B.inner_text('#attnList'), 'the panel says the challenger is offline (you fight their monster)')
        await tap(B, '[data-action="challenge:acc"]', 600)
        await B.wait_for_function("Tama.Game.ui.battle && Tama.Game.ui.battle.kind==='friend'", timeout=8000)
        g = await ev(B, "Tama.Game.ui.battle")
        check(g['ghost'] and g['opp']['card']['name'] == 'ALICE', 'accepting with the challenger offline = battle vs the server-held copy of their pet')
        check(await fight_by_tapping([B]), 'ghost challenge battle finished')

        # ================= 10. cheats: edited requests & forged socket messages =================
        await make_pet(B, 'scrapper', 'BOB')
        r = await api(B, 'POST', '/api/act', {'type': 'train_guess', 'round': 5, 'g': 1})
        check(r['data']['ok'] is False and r['data']['error'] == 'no_training', 'forged training result without a session is rejected')
        await api(B, 'POST', '/api/act', {'type': 'train_start'})
        r = await api(B, 'POST', '/api/act', {'type': 'train_guess', 'round': 3, 'g': 1})
        check(r['data']['ok'] is False and r['data']['error'] == 'bad_guess', 'skipping training rounds is rejected')
        EXPECTED_ERR.append('403 (Forbidden)')
        r = await api(B, 'POST', '/api/act', {'type': 'feed'}, tama=False)
        check(r['status'] == 403, 'requests without the X-Tama header are refused (CSRF guard)')
        r = await api(B, 'POST', '/api/act', {'type': 'give_coins', 'n': 999})
        check(r['data']['ok'] is False and r['data']['error'] == 'bad_action', 'unknown actions are rejected')
        xs = await ev(B, """new Promise(async (done) => {
          const w = new WebSocket('ws://' + location.host + '/ws');
          const next = (t) => new Promise(r => { const h = (e) => { const m = JSON.parse(e.data); if (!t || m.t === t) { w.removeEventListener('message', h); r(m); } }; w.addEventListener('message', h); });
          await next('hello');
          w.send(JSON.stringify({t:'cpu', card:{name:'HAX', formId:'drakon', xp:99999, hp:999, pow:99}}));
          const m = await next('matched'); await next('turn');
          w.send(JSON.stringify({t:'result', res:{hit:true, dmg:99}})); w.send(JSON.stringify({t:'move', dir:'nuke', n:1}));
          w.send(JSON.stringify({t:'leave'})); await next('end'); w.close();
          done({you: m.you, real: Tama.Battle.view(Tama.Battle.fighter(Tama.Battle.card(Tama.Game.state)))});
        })""")
        check(xs['you']['card']['formId'] == 'scrapper' and xs['you']['max'] == xs['real']['max'], f"socket battle ignores the client's claimed pet/stats (server used {xs['you']['card']['formId']}, hp {xs['you']['max']})")
        r = await api(B, 'POST', '/api/debug', {'op': 'patch', 'eco': {'coins': 1}})
        check(r['status'] == 200, '(main test server runs with DEBUG=1, so debug ops work here)')

        # ================= 11. guest, local-save import, upgrade, logout/login, delete =================
        ctxG, G = await new_page(browser, PHONE, 'G')
        await G.goto(BASE)
        old = dict(v=1, name='OLDIE', formId='kingleo', stage='adult', history=['egg', 'pixbit', 'mochi', 'kingleo'], eggMs=12000, ageMs=2500000, hunger=3, happy=3,
                   weight=30, discipline=50, poops=[], careMistakes=2, meals=10, snacks=3, battles=9, wins=6, plays=10, training=19, xp=999999, lastSaved=int(time.time() * 1000) - 3600e3)
        await ev(G, f"localStorage.setItem('tamapix.save.v1', {json.dumps(json.dumps(old))})")
        await G.goto(BASE); await G.wait_for_selector('#authPanel:not([hidden])')
        await tap(G, '#guestGo', 400)
        await G.wait_for_selector('#importPanel:not([hidden])', timeout=6000)
        check('OLDIE' in await G.inner_text('#importText'), 'an old browser save is offered for a one-time import')
        await shot(G, '19-phone-import-offer')
        await tap(G, '#importGo', 800); await idle(G)
        s = await st(G)
        cap = await ev(G, "Tama.Battle.xpFor(Tama.CONFIG.LEVEL_CAP.adult)")
        check(s['formId'] == 'kingleo' and s['name'] == 'OLDIE' and s['xp'] <= min(cap, 19 * 30 + 9 * 80) and s['battles'] == 9,
              f"import keeps the form, clamps suspicious XP (999999 -> {s['xp']})")
        check(await ev(G, "localStorage.getItem('tamapix.save.v1')===null") and (await ev(G, 'Tama.Game.user'))['imported'], 'the old save is imported only once')
        r = await api(G, 'POST', '/api/import', {'save': old})
        check(r['data']['ok'] is False and r['data']['error'] == 'imported', 'a second import is refused by the server')
        check((await ev(G, 'Tama.Game.user'))['isGuest'], 'guest play works without a username')
        await tap_icon(G, 'home'); await tap_zone(G, 'mSettings'); await tap_zone(G, 'sAccount')
        check(await ev(G, "!document.getElementById('upgradeForm').hidden"), 'guest account sheet offers "save as account"')
        await G.fill('#upUser', 'bob'); await G.fill('#upPass', 'secret123'); await tap(G, '#upGo', 600)
        check('taken' in await G.inner_text('#accError'), 'upgrade refuses a taken username')
        await G.fill('#upUser', 'carol'); await G.fill('#upPass', 'secret123'); await tap(G, '#upGo', 800)
        u = await ev(G, 'Tama.Game.user')
        check(not u['isGuest'] and u['username'] == 'carol', 'guest upgraded to an account (same monster)')
        await tap(G, '#accLogout', 600)
        await G.wait_for_selector('#authPanel:not([hidden])', timeout=5000)
        check(not await ev(G, 'Tama.Game.session'), 'log out returns to the log-in sheet')
        await tap(G, '#tabLogin', 100); await G.fill('#authUser', 'carol'); await G.fill('#authPass', 'wrongpass1'); await tap(G, '#authGo', 600)
        check('Wrong username or password' in await G.inner_text('#authError'), 'wrong password is refused')
        await login(G, 'carol')
        check((await st(G))['formId'] == 'kingleo', 'logging back in restores the same server-held monster')
        await ev(G, "Tama.Game.resetUI()")
        await G.reload(); await G.wait_for_function('Tama.Game.session', timeout=8000); await G.wait_for_timeout(300)
        check(await ev(G, "document.getElementById('importPanel').hidden"), 'no import offer after it was used')
        await ctxG.close()
        ctxD, D = await new_page(browser, PHONE, 'D'); await D.goto(BASE); await D.wait_for_selector('#authPanel:not([hidden])')
        await tap(D, '#guestGo', 600); await D.wait_for_function('Tama.Game.session', timeout=8000)
        D.on('dialog', lambda d: asyncio.ensure_future(d.accept()))
        await tap_icon(D, 'home'); await tap_zone(D, 'mSettings'); await tap_zone(D, 'sAccount'); await tap(D, '#accDelete', 800)
        await D.wait_for_selector('#authPanel:not([hidden])', timeout=5000)
        r = await api(D, 'GET', '/api/state')
        check(r['data'].get('auth') is False, 'guest can delete its account (session gone)')
        await ctxD.close()

        # ================= 12. server restart: data survives locally, offline message while down =================
        await make_pet(B, 'scrapper', 'BOB', pet={'xp': 321})
        await B.wait_for_timeout(1200)                        # debounced file write
        stop(node); node = None
        EXPECTED_ERR.extend(['ERR_CONNECTION_REFUSED', 'WebSocket connection', 'Failed to load resource'])
        await refresh(B); await B.wait_for_timeout(300)
        check(await ev(B, "!document.getElementById('offlinePanel').hidden"), 'server down: a clear OFFLINE message (no local play)')
        await shot(B, '20-phone-offline', 100)
        node = start_node()
        await tap(B, '#offRetry', 1200)
        rr = [await ev(B, "document.getElementById('offlinePanel').hidden"), (await st(B))['xp']]
        check(rr[0] and rr[1] == 321, f'RETRY reconnects; the pet was kept by the file store across the restart {rr}')
        del EXPECTED_ERR[:]
        await ctxB.close()

        # ================= 13. static host and file:// -> OFFLINE message =================
        static = start_static()
        EXPECTED_ERR.extend(['404', 'Failed to load resource'])
        ctx, pg = await new_page(browser, PHONE, 'static')
        await pg.goto(f'http://localhost:{STATIC_PORT}/'); await pg.wait_for_selector('#offlinePanel:not([hidden])', timeout=6000)
        check('not the game server' in await pg.inner_text('#offDetail'), 'page on a static host: OFFLINE explains the game server is missing')
        await ctx.close(); stop(static)
        ctx, pg = await new_page(browser, PHONE, 'file')
        await pg.goto('file://' + os.path.join(ROOT, 'index.html')); await pg.wait_for_selector('#offlinePanel:not([hidden])', timeout=6000)
        check('opened as a file' in await pg.inner_text('#offDetail'), 'file:// shows OFFLINE with how to start the server')
        await ctx.close()
        del EXPECTED_ERR[:]

        # ================= 14. production-like server: no debug, real rate limits, ephemeral warning =================
        prod = start_node(PROD_PORT, {'DEBUG': None, 'NODE_ENV': 'production', 'RATE_LIMIT_SCALE': None, 'DATA_FILE': '/tmp/tama-e2e-prod.json', 'SESSION_SECRET': 'test-secret-123'}, '/tmp/tama-prod.log')
        h = Http(PROD_PORT)
        code_, cfg, _ = h.call('GET', '/api/config')
        check(cfg['ephemeral'] is True and cfg['debug'] is False and cfg['storage'] == 'file', f'production without DATABASE_URL: file store flagged as ephemeral ({cfg})')
        code_, d, hd = h.call('POST', '/api/signup', {'username': 'prodtest', 'password': 'secret123'})
        check(code_ == 200 and 'Secure' in {k.lower(): v for k, v in hd.items()}.get('set-cookie', '') and 'HttpOnly' in {k.lower(): v for k, v in hd.items()}.get('set-cookie', ''), 'production cookies are Secure + HttpOnly')
        code_, d, _ = h.call('POST', '/api/debug', {'op': 'patch', 'eco': {'coins': 99999}})
        check(code_ == 403, 'debug time tools are OFF in production (403)')
        codes = [h.call('POST', '/api/login', {'username': 'prodtest', 'password': 'nope-nope'})[0] for _ in range(12)]
        check(codes[-1] == 429 and 429 not in codes[:9], f'login attempts are rate-limited ({codes})')
        ctx, pg = await new_page(browser, PHONE, 'prod')
        await pg.goto(f'http://localhost:{PROD_PORT}/'); await pg.wait_for_selector('#authPanel:not([hidden])', timeout=6000)
        check(await ev(pg, "!document.getElementById('ephemeralNote').hidden"), 'log-in sheet warns "test server: saves reset on restart"')
        await ctx.close(); stop(prod)

        # ================= 15. desktop layout, evolution tree, debug panel =================
        ctx, pg = await new_page(browser, DESK, 'desk')
        await pg.goto(BASE + '?debug=1'); await signup(pg, 'deskuser')
        await make_pet(pg, 'starla', 'LUNA')
        await shot(pg, '21-desktop-home', 400)
        await tap_icon(pg, 'status'); check(await mode(pg) == 'status', 'desktop: mouse clicks on icons work'); await tap_icon(pg, 'back')
        TREE = [
            ({'poopMistakes': 5}, {'training': 8, 'battles': 4, 'wins': 2, 'losses': 2}, 'muck', 'toxitan'),
            ({'battles': 7, 'wins': 6, 'losses': 1}, {'battles': 10, 'wins': 8, 'losses': 2, 'careMistakes': 1, 'pet': {'discipline': 75}}, 'vesper', 'seraphi'),
            ({'battles': 7, 'wins': 1, 'losses': 6}, {'battles': 8, 'wins': 5, 'losses': 3}, 'scrapper', 'dreadclaw'),
            ({'snacks': 12, 'meals': 10}, {'training': 12}, 'blobbo', 'rokkun'),
            ({'careMistakes': 1, 'training': 6, 'pet': {'discipline': 75}}, {'careMistakes': 0, 'pet': {'discipline': 100}}, 'nekoru', 'starla'),
            ({'careMistakes': 5}, {'careMistakes': 6}, 'kuchibo', 'ghoulie'),
            ({'battles': 7, 'wins': 7}, {'battles': 9, 'wins': 9}, 'vesper', 'drakon'),
        ]
        for baby, teen, mid, final in TREE:
            hh = (await ev(pg, f"Tama.Debug.runScenario({json.dumps(baby)}, {json.dumps(teen)})"))['history']
            check(hh[2:] == [mid, final], f'evolution: {baby} then {teen} -> {mid} -> {final} (got {hh[2:]})')
        await ev(pg, "document.querySelector('#debug').classList.remove('collapsed')")
        await dbg(pg, {'op': 'force', 'form': 'blob'}); await pg.wait_for_timeout(700)
        opts = await ev(pg, "[...document.querySelectorAll('#dbgBranch option')].map(function(o){return o.value})")
        check(opts == ['muck', 'vesper', 'scrapper', 'blobbo', 'nekoru', 'kuchibo'], f'debug lists the branches of the current form {opts}')
        await pg.select_option('#dbgBranch', 'muck'); await pg.locator('[data-d="force"]').click(); await pg.wait_for_timeout(600)
        check((await st(pg))['formId'] == 'muck' and await ev(pg, "!!Tama.Game.ui.anim"), 'debug panel forces a branch on the server (with the evolution animation)')
        await idle(pg)
        e1 = (await eco(pg))['coins']; await pg.locator('[data-d="coins"]').click(); await pg.wait_for_timeout(500)
        check((await eco(pg))['coins'] == e1 + 500, 'debug +500 coins (server op)')
        await pg.locator('[data-d="e0"]').click(); await pg.wait_for_timeout(500)
        s = await st(pg); check(s['energy'] == 0 or s['asleep'], 'debug energy 0 -> it collapses into a nap')
        await ev(pg, "Tama.Debug.gallery()")
        n = await ev(pg, "document.querySelectorAll('#gallery .gal-cell').length")
        check(n == 2 + 6 + 12 + 1, f'debug gallery shows the whole tree ({n} forms)')
        await pg.add_style_tag(content='html,body{height:auto!important;overflow:visible!important} #scene,.bar,.wallet,#debug{display:none!important} #gallery{position:static!important;inset:auto!important;border:0}')
        await pg.wait_for_timeout(300); await pg.screenshot(path=f'{SHOTS}/22-evolution-tree.png', full_page=True)
        await ctx.close()

        # home HUD screenshot with a nice pet (last, so it isn't covered by toasts)
        ctx, pg = await new_page(browser, PHONE, 'hud')
        await pg.goto(BASE); await signup(pg, 'hudshot')
        await make_pet(pg, 'vesper', 'PIPO', pet={'xp': 540, 'energy': 74}, eco_={'coins': 240})
        await ev(pg, "var u=Tama.Game.ui; u.pet.x=14; u.pet.move='hop'; u.emote='heart'; u.emoteUntil=performance.now()+1e9; u.nextThink=performance.now()+1e9;")
        await shot(pg, '02-phone-home-hud', 600)
        check((await pg.inner_text('#coinNum')) == '240' and (await pg.inner_text('#energyNum')).startswith('74'), 'home HUD shows energy 74 and 240 coins')
        await ctx.close()

        # ================= 16. optional: Postgres adapter smoke test =================
        pgurl = os.environ.get('PG_TEST_URL')
        if pgurl:
            pgs = start_node(PG_PORT, {'DATABASE_URL': pgurl, 'DATA_FILE': None}, '/tmp/tama-pg.log')
            h = Http(PG_PORT)
            _, cfg, _ = h.call('GET', '/api/config')
            name = 'pg' + str(int(time.time()) % 100000)
            c1, d1, _ = h.call('POST', '/api/signup', {'username': name, 'password': 'secret123'})
            h.call('POST', '/api/debug', {'op': 'hatch'})
            c2, d2, _ = h.call('POST', '/api/act', {'type': 'train_start'})
            stop(pgs); pgs = start_node(PG_PORT, {'DATABASE_URL': pgurl, 'DATA_FILE': None}, '/tmp/tama-pg.log')
            c3, d3, _ = h.call('GET', '/api/state')
            c4, d4, _ = h.call('GET', '/api/ledger')
            check(cfg['storage'] == 'postgres' and d1.get('ok') and d2.get('ok') and d3['pet']['stage'] == 'baby' and d3['pet']['energy'] <= 90 and any(x['reason'] == 'daily_gift' for x in d4['ledger']),
                  f"Postgres: sign-up, act, restart -> state and coin ledger persist ({cfg['storage']}, energy {d3['pet']['energy']})")
            stop(pgs)
        else:
            print('SKIP Postgres smoke test (set PG_TEST_URL to run it)')

        await browser.close()
    stop(node)
    print('\nconsole errors/warnings:', errors)
    if errors: fails.append('console errors')
    print('FAILURES:', fails)
    print(f'{len(fails)} failures')
    sys.exit(1 if fails else 0)

asyncio.run(main())
