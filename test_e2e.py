"""TAMA-PIX end-to-end tests + screenshots (tap-only; no keyboard input is used anywhere).

Starts/stops its own servers:  node server/server.js on :8765, later python http.server on :8765.
Run:  python3 test_e2e.py
"""
import asyncio, base64, json, os, random, subprocess, sys, time
from playwright.async_api import async_playwright

ROOT = os.path.dirname(os.path.abspath(__file__))
SHOTS = os.path.join(ROOT, 'screenshots')
os.makedirs(SHOTS, exist_ok=True)
PORT = 8765
BASE = f'http://localhost:{PORT}/'
PHONE = dict(viewport={'width': 390, 'height': 844}, device_scale_factor=2, is_mobile=True, has_touch=True)
DESK = dict(viewport={'width': 800, 'height': 900})
errors, fails = [], []

def check(cond, msg):
    print(('PASS ' if cond else 'FAIL ') + msg, flush=True)
    if not cond: fails.append(msg)

def start_node():
    p = subprocess.Popen(['node', 'server.js'], cwd=os.path.join(ROOT, 'server'), env={**os.environ, 'PORT': str(PORT)},
                         stdout=open('/tmp/tama-node.log', 'w'), stderr=subprocess.STDOUT)
    time.sleep(0.8)
    assert p.poll() is None, 'node server failed to start (port busy?)'
    return p

def start_static():
    p = subprocess.Popen([sys.executable, '-m', 'http.server', str(PORT)], cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(0.8)
    assert p.poll() is None, 'static server failed to start (port busy?)'
    return p

def stop(p):
    if p and p.poll() is None: p.terminate(); p.wait(5)

def watch(pg, tag):
    pg.on('console', lambda m: errors.append(f'{tag} {m.type}: {m.text}') if m.type in ('error', 'warning') else None)
    pg.on('pageerror', lambda e: errors.append(f'{tag} pageerror: {e}'))

async def new_page(browser, opts, tag):
    ctx = await browser.new_context(**opts)
    pg = await ctx.new_page(); watch(pg, tag); pg.touch = opts.get('has_touch', False)
    return ctx, pg

async def tap_icon(pg, name, wait=250):
    loc = pg.locator(f'.pbtn[data-icon="{name}"]')
    await (loc.tap() if pg.touch else loc.click()); await pg.wait_for_timeout(wait)

async def tap_lcd(pg, lx, ly, wait=320):
    """Tap the scene at stage pixel (lx, ly) (the 48x24 gameplay stage on the meadow)."""
    c = await pg.evaluate(f'Tama.Game.stageToClient({lx + 0.5}, {ly + 0.5})')
    await (pg.touchscreen.tap(c['x'], c['y']) if pg.touch else pg.mouse.click(c['x'], c['y'])); await pg.wait_for_timeout(wait)

async def tap_zone(pg, zid, wait=320):
    """Tap the on-screen choice/zone with this id (menus, HI/LO, status, pet...)."""
    c = await pg.evaluate(f"Tama.Game.zonePoint('{zid}')")
    assert c, f'zone {zid} not on screen'
    await (pg.touchscreen.tap(c['x'], c['y']) if pg.touch else pg.mouse.click(c['x'], c['y'])); await pg.wait_for_timeout(wait)

async def ev(pg, js): return await pg.evaluate(js)
async def st(pg): return await ev(pg, 'JSON.parse(JSON.stringify(Tama.Game.state))')
async def mode(pg): return await ev(pg, 'Tama.Game.ui.mode')
async def idle(pg, ms=8000): await pg.wait_for_function('!Tama.Game.ui.anim && Tama.Game.ui.queue.length===0', timeout=ms)

async def fresh(pg, url=BASE):
    await pg.goto(url); await ev(pg, 'localStorage.clear()'); await pg.goto(url); await pg.wait_for_timeout(300)

async def make_pet(pg, form='nekoru', name='PIPO', extra=''):
    """Hatch and turn the pet into `form` at the start of its stage, at noon on its clock (awake)."""
    await ev(pg, f"""(function(){{var s=Tama.Game.state; s.eggMs=Tama.CONFIG.T.HATCH; Tama.Pet.simulate(s,1000);
      Tama.Pet.evolve(s,'{form}'); s.ageMs=Tama.Evolution.entryAge('{form}')+2000; Tama.Pet.setClock(s,12); s.asleep=false;
      s.name='{name}'; s.hunger=4; s.happy=4; s.training=6; s.battles=3; s.wins=2; s.xp=120; s.poops=[]; s.sick=false; s.dead=false; {extra}
      Tama.Game.resetUI(); Tama.Game.ui.anim=null; Tama.Game.ui.queue=[];}})()""")
    await pg.wait_for_timeout(250)

async def fight_by_tapping(pages, shot=None, max_s=90):
    """Tap HI/LO on every page that's waiting for a move, until no page is in a battle."""
    t0 = time.time(); shot_done = False
    while time.time() - t0 < max_s:
        busy = False
        for pg in pages:
            info = await ev(pg, "(function(){var B=Tama.Game.ui.battle; return B?{p:B.phase,k:B.kind}:null})()")
            if info is None: continue
            busy = True
            if info['p'] == 'choose':
                try: await pg.wait_for_function("Tama.Game.zonePoint('hi') || !Tama.Game.ui.battle || Tama.Game.ui.battle.phase!=='choose'", timeout=3000)
                except Exception: continue
                if not await ev(pg, "!!Tama.Game.zonePoint('hi')"): continue
                await tap_zone(pg, random.choice(['hi', 'lo']), wait=150)
                await pg.wait_for_function("!Tama.Game.ui.battle || Tama.Game.ui.battle.phase!=='choose'", timeout=3000)
            elif shot and not shot_done and info['p'] == 'anim' and pg is pages[0]:
                await pg.wait_for_timeout(420); await pg.screenshot(path=shot); shot_done = True
        if not busy: return True
        await asyncio.sleep(0.12)
    return False

async def main():
    for f in os.listdir(SHOTS):
        if f.endswith('.png'): os.remove(os.path.join(SHOTS, f))
    node = start_node()
    async with async_playwright() as p:
        browser = await p.chromium.launch()

        # ================= 1. phone layout + tap-only care loop =================
        ctx, pg = await new_page(browser, PHONE, 'phone')
        await fresh(pg)
        check(await ev(pg, "document.querySelectorAll('#device, .lcd-glass, #lcd, .keychain, [data-btn]').length") == 0, 'no egg shell / keyring / LCD / A-B-C buttons left in the DOM')
        sizes = await ev(pg, "[...document.querySelectorAll('button.pbtn')].map(e=>{const r=e.getBoundingClientRect();return [e.dataset.icon, r.width, r.height]})")
        check(len(sizes) == 10 and all(w >= 44 and h >= 44 for _, w, h in sizes), f'HUD tap targets >= 44px on phone: {[(n, round(w), round(h)) for n, w, h in sizes]}')
        cov = await ev(pg, "(function(){var r=document.getElementById('scene').getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom]})()")
        check(cov[0] <= 0 and cov[1] <= 0 and cov[2] >= 390 and cov[3] >= 844, f'scene canvas fills the whole 390x844 screen {[round(v) for v in cov]}')
        css = await ev(pg, "(function(){var b=getComputedStyle(document.body); return [b.touchAction, b.userSelect||b.webkitUserSelect, getComputedStyle(document.getElementById('scene')).touchAction]})()")
        check(css[0] == 'manipulation' and css[1] == 'none' and css[2] == 'manipulation', f'double-tap zoom & text selection disabled {css}')
        check(await ev(pg, "document.documentElement.scrollWidth <= 390 && document.documentElement.scrollHeight <= 844"), 'no scrolling on phone')

        cfg = await ev(pg, "({h:Tama.CONFIG.T.HATCH, t:Tama.CONFIG.T.TEEN_AT, a:Tama.CONFIG.T.ADULT_AT, d:Tama.CONFIG.T.DAY, sp:Tama.CONFIG.SPEED})")
        check(cfg['h'] == 60000 and cfg['t'] == 2 * cfg['d'] and cfg['a'] == 5 * cfg['d'] and cfg['d'] == 86400000 and cfg['sp'] == 1,
              f'real-time timing: hatch 1 min, evolve at day 2 and day 5, speed 1 without ?debug ({cfg})')
        check(await ev(pg, "(function(){var s=Tama.Pet.create(); Tama.Pet.simulate(s, 59000); var a=s.stage; Tama.Pet.simulate(s, 2000); return a==='egg' && s.stage==='baby'})()"),
              'egg hatches after one minute')
        await ev(pg, "Tama.Game.state.eggMs=Tama.CONFIG.T.HATCH-200")
        await pg.wait_for_function("Tama.Game.state.stage==='baby'", timeout=4000); await idle(pg)
        check((await st(pg))['formId'] == 'blob', 'every pet hatches as the BLOB')
        check((await st(pg))['xp'] == 0 and await ev(pg, "Tama.Pet.level(Tama.Game.state)") == 1, 'a new hatchling is Lv 1 with 0 XP')

        h0 = (await st(pg))['hunger']
        await tap_icon(pg, 'feed'); check(await mode(pg) == 'feedMenu', 'tapping FEED icon opens the meal/snack screen')
        await tap_zone(pg, 'opt0'); await idle(pg)
        check((await st(pg))['hunger'] == h0 + 1, 'tapping MEAL feeds a meal')
        await tap_icon(pg, 'feed'); await tap_zone(pg, 'opt1'); await idle(pg)
        check((await st(pg))['snacks'] == 1, 'tapping SNACK gives a snack')
        await tap_icon(pg, 'feed'); await tap_icon(pg, 'back')
        check(await mode(pg) == 'main', 'back arrow leaves the feed screen')

        await tap_icon(pg, 'play'); check(await mode(pg) == 'play', 'PLAY icon starts the left/right game')
        for i in range(5):
            await pg.wait_for_function("Tama.Game.ui.play && Tama.Game.ui.play.phase==='wait'", timeout=5000)
            await tap_zone(pg, 'left' if i % 2 else 'right', wait=50)
            await pg.wait_for_function("!Tama.Game.ui.play || Tama.Game.ui.play.phase!=='wait'", timeout=3000)
        await pg.wait_for_function("Tama.Game.ui.mode==='main'", timeout=8000)
        s1 = await st(pg)
        check(s1['plays'] == 1, 'play game completed by tapping')
        check(10 <= s1['xp'] <= 30 and s1['st']['training'] == 1, f"training gives XP ({s1['xp']}) and counts for this stage")
        xp_before = s1['xp']
        aged = await ev(pg, "(function(){var s=JSON.parse(JSON.stringify(Tama.Game.state)); Tama.Pet.simulate(s, Tama.CONFIG.T.DAY); return [s.xp, Tama.Pet.level(s), s.ageMs>Tama.CONFIG.T.DAY]})()")
        check(aged[0] == xp_before and aged[2], f'a day passing adds no XP (xp {aged[0]}, Lv {aged[1]}) - levels only from training/battles')
        lv = await ev(pg, "[0,29,30,70,630,2280,13230,99999].map(function(x){return Tama.Battle.levelFromXp(x)})")
        check(lv == [1, 1, 2, 3, 10, 20, 50, 50], f'level curve from XP {lv}')
        st5 = await ev(pg, "[Tama.Battle.statsFor({formId:'kingleo',xp:0,weight:25}), Tama.Battle.statsFor({formId:'kingleo',xp:Tama.Battle.xpFor(30),weight:25})]")
        check(st5[1]['pow'] > st5[0]['pow'] and st5[1]['hp'] > st5[0]['hp'], f'level raises battle stats (Lv1 {st5[0]} vs Lv30 {st5[1]})')

        await tap_icon(pg, 'status'); check(await mode(pg) == 'status', 'STATUS icon opens status')
        left = await ev(pg, "Tama.Pet.evolvesIn(Tama.Game.state)")
        check(left is not None and 1.99 * 86400000 < left <= 2 * 86400000, f'status: first evolution due in ~2 days ({left/3600000:.1f} h)')
        await tap_zone(pg, 'status'); await pg.wait_for_timeout(200)
        await pg.screenshot(path=f'{SHOTS}/03b-phone-status-hunger.png')
        await tap_icon(pg, 'back'); await tap_icon(pg, 'status')
        pages = []
        for _ in range(5):
            pages.append(await ev(pg, 'Tama.Game.ui.page')); await tap_zone(pg, 'status')
        check(pages == [0, 1, 2, 3, 4] and await mode(pg) == 'main', f'tapping the screen pages through status {pages}')
        await tap_icon(pg, 'status'); await tap_zone(pg, 'status'); await tap_icon(pg, 'back')
        check(await mode(pg) == 'main', 'back arrow exits status')

        await ev(pg, "var s=Tama.Game.state; s.poops=[{age:0,counted:false},{age:0,counted:false}]; Tama.Pet.makeSick(s); s.doses=1;")
        await tap_icon(pg, 'medicine'); await idle(pg); check(not (await st(pg))['sick'], 'MEDICINE icon cures')
        await tap_icon(pg, 'bath'); await idle(pg); check(len((await st(pg))['poops']) == 0, 'BATHROOM icon cleans')
        await ev(pg, "var s=Tama.Game.state; s.fakeCall=true; s.fakeCallMs=0;")
        await tap_icon(pg, 'discipline'); await idle(pg); check((await st(pg))['discipline'] == 25, 'DISCIPLINE icon scolds a fake call')
        await ev(pg, "var s=Tama.Game.state; s.ageMs=Math.max(s.ageMs, Tama.CONFIG.T.NEWBORN_AWAKE+1000); Tama.Pet.setClock(s, 23)")
        await pg.wait_for_function("Tama.Game.state.asleep", timeout=3000)
        await tap_icon(pg, 'light'); await tap_zone(pg, 'opt1')
        s = await st(pg); check(s['asleep'] and s['lightsOff'], 'LIGHT icon -> OFF turns lights off while asleep')
        check(await ev(pg, "document.body.dataset.env") == 'night', 'lights off switches the meadow to the night sky')
        await pg.wait_for_timeout(700); await pg.screenshot(path=f'{SHOTS}/02-phone-night.png')
        await ev(pg, "Tama.Pet.setClock(Tama.Game.state, 12)"); await pg.wait_for_function("!Tama.Game.state.asleep", timeout=3000)

        # tapping the pet: a reaction, but no highlight box / outline around it
        await ev(pg, "var u=Tama.Game.ui; u.pet.x=30; u.pet.move='stay'; u.nextThink=performance.now()+1e9;"); await pg.wait_for_timeout(200)
        c = await ev(pg, "Tama.Game.zonePoint('pet')")
        await pg.touchscreen.tap(c['x'], c['y']); await pg.wait_for_timeout(30)
        fx = await ev(pg, "Tama.Game.ui.tapFx")
        await pg.screenshot(path=f'{SHOTS}/10-phone-pet-tap-no-outline.png')
        await pg.wait_for_timeout(150)
        check(await ev(pg, "Tama.Game.ui.petted > performance.now()"), 'tapping the pet makes it react')
        outline = await ev(pg, "[getComputedStyle(document.getElementById('scene')).outlineStyle, document.activeElement===document.getElementById('scene'), getComputedStyle(document.body).webkitTapHighlightColor]")
        check(fx is None and outline[0] == 'none' and not outline[1] and outline[2] in ('rgba(0, 0, 0, 0)', 'transparent'),
              f'tapping the pet shows no highlight box or focus outline (tapFx={fx}, css={outline})')

        await make_pet(pg, 'vesper', 'PIPO', "s.poops=[{age:0,counted:false}]; s.xp=540; s.ageMs=Tama.CONFIG.T.ADULT_AT-(28*3600e3+17*60e3); Tama.Pet.setClock(s,12); s.st.battles=6; s.st.wins=5; s.st.losses=1; s.st.training=4;")
        await ev(pg, "var u=Tama.Game.ui; u.pet.x=10; u.pet.move='hop'; u.emote='heart'; u.emoteUntil=performance.now()+1e9; u.nextThink=performance.now()+1e9;")
        await pg.wait_for_timeout(400); await pg.screenshot(path=f'{SHOTS}/01-phone-home-day.png')
        check(await ev(pg, "document.body.dataset.env") == 'day', 'daytime meadow')
        await tap_icon(pg, 'status'); await pg.wait_for_timeout(250)
        await pg.screenshot(path=f'{SHOTS}/03-phone-status-level-countdown.png')
        info = await ev(pg, "[Tama.Pet.level(Tama.Game.state), Tama.Pet.evolvesIn(Tama.Game.state)]")
        check(info[0] == 9 and abs(info[1] - (28 * 3600e3 + 17 * 60e3)) < 5000, f'status shows Lv {info[0]} and evolves in 1d 4h ({info[1]/3600000:.2f} h)')
        await tap_icon(pg, 'back')
        await ev(pg, "Tama.Game.ui.nextThink=0; Tama.Game.ui.emote=null")

        await tap_icon(pg, 'battle'); check(await mode(pg) == 'battleMenu', 'BATTLE icon opens RANDOM/FRIEND/CPU menu')
        await pg.wait_for_timeout(200); await pg.screenshot(path=f'{SHOTS}/05-phone-battle-menu.png')
        b0 = (await st(pg))['battles']
        await tap_zone(pg, 'opt2')
        check(await ev(pg, "Tama.Game.ui.battle && Tama.Game.ui.battle.kind") == 'cpu', 'CPU option starts a computer battle')
        check(await fight_by_tapping([pg]), 'CPU battle played to the end by tapping HI/LO')
        s2 = await st(pg)
        check(s2['battles'] == b0 + 1, 'CPU battle recorded')
        check(s2['xp'] > 540 and s2['st']['battles'] == 7, f"battle gives XP ({s2['xp'] - 540}) and counts for this stage")
        xw = await ev(pg, "[Tama.Battle.battleXp('win',10,10), Tama.Battle.battleXp('win',10,14), Tama.Battle.battleXp('loss',10,10), Tama.Battle.battleXp('loss',10,14), Tama.Battle.battleXp('fled',10,20)]")
        check(xw[0] > xw[2] > 0 and xw[1] > xw[0] and xw[3] > xw[2] and xw[4] == 0, f'win XP > loss XP > 0, more vs higher-level foes, nothing for fleeing {xw}')

        code = await ev(pg, "Tama.Battle.encode({name:'RIVAL',formId:'kingleo',xp:640,training:9,wins:7,battles:9,weight:33})")
        await tap_icon(pg, 'battle'); await tap_zone(pg, 'opt1')
        check(await ev(pg, "!document.getElementById('linkPanel').hidden"), 'FRIEND option opens the friend-code sheet')
        my = await pg.inner_text('#myCode')
        mine = await ev(pg, f"Tama.Battle.decode({json.dumps(my)})||{{}}")
        check(mine.get('formId') == 'vesper' and mine.get('xp', 0) > 540, f'sheet shows own code with species and XP {mine}')
        old = await ev(pg, """(function(){var body=['TP1','OLDPAL','mochi',4,2,3,12].join('|'), h=7; for (var ch of body) h=(h*31+ch.charCodeAt(0))%1296;
            return Tama.Battle.decode('TP-'+btoa(body+'|'+h.toString(36)).replace(/=+$/,''))})()""")
        check(old and old['formId'] == 'nekoru' and old['xp'] > 0, f'old TP1 friend codes still work (legacy form mapped) {old}')
        oldb = await ev(pg, """(function(){var body=['TP1','BABY','pixbit',1,0,0,6].join('|'), h=7; for (var ch of body) h=(h*31+ch.charCodeAt(0))%1296;
            return Tama.Battle.decode('TP-'+btoa(body+'|'+h.toString(36)).replace(/=+$/,''))})()""")
        check(oldb and oldb['formId'] == 'blob', f'old FANGLET friend codes become the BLOB {oldb}')
        await pg.fill('#friendCode', 'TP-nonsense'); await pg.locator('#linkFight').tap()
        check('look right' in await pg.inner_text('#linkError'), 'bad friend code shows an error')
        await pg.fill('#friendCode', code); await pg.wait_for_timeout(100)
        pass
        await pg.locator('#linkFight').tap(); await pg.wait_for_timeout(200)
        check(await ev(pg, "Tama.Game.ui.battle && Tama.Game.ui.battle.opp.card.formId") == 'kingleo', 'friend battle uses the code species')
        check(await ev(pg, "Tama.Battle.level(Tama.Game.ui.battle.opp.card)") == 10, 'friend level comes from the code XP (Lv 10)')
        await pg.wait_for_function("Tama.Game.ui.battle.phase==='choose'", timeout=5000)
        await tap_icon(pg, 'back')
        check(await ev(pg, "Tama.Game.ui.battle && Tama.Game.ui.battle.reason") == 'fled', 'back arrow flees a battle')
        await pg.wait_for_function("Tama.Game.ui.mode==='main'", timeout=5000)

        await ev(pg, "var s=Tama.Game.state; s.hunger=0; s.hungerZeroMs=Tama.CONFIG.T.STARVE_DEATH-1200")
        await pg.wait_for_function("Tama.Game.state.dead", timeout=5000); await pg.wait_for_timeout(400)
        await tap_zone(pg, 'dead'); check(await mode(pg) == 'deadConfirm', 'tapping the death screen asks NEW EGG?')
        await tap_icon(pg, 'back'); check(await mode(pg) == 'main' and (await st(pg))['dead'], 'back from NEW EGG? returns to the grave')
        await tap_zone(pg, 'dead'); await tap_zone(pg, 'yes')
        s = await st(pg); check(s['stage'] == 'egg' and not s['dead'], 'tapping YES starts a new egg')
        await ctx.close()

        # ================= 2. desktop layout =================
        ctx, pg = await new_page(browser, DESK, 'desk')
        await fresh(pg); await make_pet(pg, 'starla', 'LUNA')
        await ev(pg, "var u=Tama.Game.ui; u.pet.x=16; u.emote='note'; u.emoteUntil=performance.now()+1e9; u.nextThink=performance.now()+1e9;")
        await pg.wait_for_timeout(400); await pg.screenshot(path=f'{SHOTS}/09-desktop-home.png')
        cov = await ev(pg, "(function(){var r=document.getElementById('scene').getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom]})()")
        check(cov[0] <= 0 and cov[1] <= 0 and cov[2] >= 800 and cov[3] >= 900, 'desktop: scene fills the window')
        pet = await ev(pg, "(function(){var a=Tama.Game.stageToClient(0,0), b=Tama.Game.stageToClient(96,48); return [a.y, b.y]})()")
        check(pet[0] > 64 and pet[1] < 900 - 64, 'desktop: stage sits between the HUD bars')
        await tap_icon(pg, 'status'); check(await mode(pg) == 'status', 'desktop: mouse click on icons works')
        TREE = [  # (days 0-2 counters, days 2-5 counters, expected day-2 form, expected final)
            ({'poopMistakes': 5}, {'training': 8, 'battles': 4, 'wins': 2, 'losses': 2}, 'muck', 'toxitan'),
            ({'poopMistakes': 4}, {'poopMistakes': 5}, 'muck', 'sludgeking'),
            ({'battles': 7, 'wins': 6, 'losses': 1}, {'battles': 10, 'wins': 8, 'losses': 2, 'careMistakes': 1, 'pet': {'discipline': 75}}, 'vesper', 'seraphi'),
            ({'battles': 7, 'wins': 6, 'losses': 1}, {'battles': 10, 'wins': 3, 'losses': 7}, 'vesper', 'noxseraph'),
            ({'battles': 7, 'wins': 1, 'losses': 6}, {'battles': 8, 'wins': 5, 'losses': 3}, 'scrapper', 'dreadclaw'),
            ({'battles': 6, 'wins': 0, 'losses': 6}, {'battles': 4, 'wins': 1, 'losses': 3}, 'scrapper', 'oyaji'),
            ({'snacks': 12, 'meals': 10}, {'training': 12}, 'blobbo', 'rokkun'),
            ({'snacks': 12, 'meals': 10}, {'snacks': 15, 'pet': {'weight': 45}}, 'blobbo', 'chubbo'),
            ({'careMistakes': 1, 'training': 6, 'pet': {'discipline': 75}}, {'careMistakes': 0, 'pet': {'discipline': 100}}, 'nekoru', 'starla'),
            ({'careMistakes': 2, 'training': 5, 'pet': {'discipline': 50}}, {'careMistakes': 3}, 'nekoru', 'kingleo'),
            ({'careMistakes': 5}, {'careMistakes': 6}, 'kuchibo', 'ghoulie'),
            ({}, {'training': 10}, 'kuchibo', 'mimiko'),
            ({'battles': 7, 'wins': 7}, {'battles': 9, 'wins': 9}, 'vesper', 'drakon'),
        ]
        for baby, teen, mid, final in TREE:
            h = (await ev(pg, f"Tama.Debug.runScenario({json.dumps(baby)}, {json.dumps(teen)})"))['history']
            check(h[2:] == [mid, final], f'evolution: {baby} then {teen} -> {mid} -> {final} (got {h[2:]})')
        allf = await ev(pg, "[Object.keys(Tama.EVOLUTION.tree.blob.reduce(function(o,b){o[b.to]=1;return o},{})).length, Object.keys(Tama.FORMS).filter(function(k){return Tama.FORMS[k].stage==='adult'}).length]")
        check(allf[0] == 6 and allf[1] == 13, f'tree: 6 day-2 forms, 12 finals + 1 secret ({allf})')
        early = await ev(pg, "(function(){var s=Tama.Pet.create(); s.eggMs=Tama.CONFIG.T.HATCH; Tama.Pet.simulate(s,1000); Tama.Pet.setClock(s,12); s.hunger=4; s.happy=4; s.ageMs=Tama.CONFIG.T.TEEN_AT-60000; Tama.Pet.setClock(s,12); Tama.Pet.simulate(s,30000); var a=s.formId; Tama.Pet.simulate(s,60000); return [a, s.formId]})()")
        check(early == ['blob', 'kuchibo'], f'no evolution before day 2, evolves right after ({early})')

        # time away: the age counts fully, needs decay softly; a normal day away is survivable
        away = await ev(pg, """(function(){var s=Tama.Pet.create(); s.eggMs=Tama.CONFIG.T.HATCH; Tama.Pet.simulate(s,1000); s.hunger=4; s.happy=4;
            Tama.Pet.simulate(s, 20*3600e3, null, {away:true}); return [s.dead, s.ageMs/3600e3, s.careMistakes]})()""")
        check(not away[0] and away[1] >= 20, f'20 h away: still alive, aged {away[1]:.1f} h ({away[2]} care mistakes)')
        away3 = await ev(pg, """(function(){var s=Tama.Pet.create(); s.eggMs=Tama.CONFIG.T.HATCH; Tama.Pet.simulate(s,1000); s.hunger=4; s.happy=4;
            Tama.Pet.simulate(s, 3*86400e3, null, {away:true}); return [s.dead, s.stage, s.careMistakes, s.ageMs/86400e3]})()""")
        check(not away3[0] and away3[1] == 'teen' and away3[3] >= 3, f'3 days away: alive, evolved on the real clock at day 2 ({away3})')
        long = await ev(pg, """(function(){var s=Tama.Pet.create(); s.eggMs=Tama.CONFIG.T.HATCH; Tama.Pet.simulate(s,1000);
            Tama.Pet.simulate(s, 10*86400e3, null, {away:true}); return [s.dead, s.cause]})()""")
        check(long[0], f'10 days of total neglect is fatal ({long})')
        starve = await ev(pg, """(function(){var s=Tama.Pet.create(); s.eggMs=Tama.CONFIG.T.HATCH; Tama.Pet.simulate(s,1000); Tama.Pet.setClock(s,8); s.hunger=0; s.happy=4;
            var t=0; while(!s.dead && t<5*86400e3){ s.happy=4; s.poops=[]; s.sick=false; Tama.Pet.simulate(s, 3600e3); t+=3600e3; } return [s.dead, t/3600e3, s.cause]})()""")
        check(starve[0] and starve[1] >= 30, f'starving (nothing else wrong) takes {starve[1]:.0f} h of real time to kill ({starve[2]})')
        await ctx.close()

        # save migration: an old v1 pet keeps its form, gets the new timing and no errors
        ctx, pg = await new_page(browser, PHONE, 'migrate')
        await pg.goto(BASE)
        for old, want_form, want_stage in [({'formId': 'kingleo', 'stage': 'adult', 'ageMs': 1300000, 'battles': 9, 'wins': 6, 'plays': 10, 'training': 19}, 'kingleo', 'adult'),
                                           ({'formId': 'mochi', 'stage': 'child', 'ageMs': 300000, 'battles': 1, 'wins': 1, 'plays': 3, 'training': 4}, 'nekoru', 'teen'),
                                           ({'formId': 'pixbit', 'stage': 'baby', 'ageMs': 60000, 'battles': 0, 'wins': 0, 'plays': 1, 'training': 1}, 'blob', 'baby'),
                                           ({'formId': 'seraphi', 'stage': 'secret', 'ageMs': 2500000, 'battles': 2, 'wins': 2, 'plays': 2, 'training': 4}, 'seraphi', 'adult')]:
            save = dict(v=1, name='OLDIE', history=['egg', 'pixbit', old['formId']], eggMs=12000, hunger=3, happy=3, weight=30, discipline=50,
                        poops=[], careMistakes=2, meals=10, snacks=3, secretChecked=False, lastSaved=int(time.time() * 1000) - 3600e3, **old)
            await ev(pg, f"Tama.Pet.save=function(){{}}; localStorage.setItem('tamapix.save.v1', {json.dumps(json.dumps(save))})")
            await pg.goto(BASE); await pg.wait_for_timeout(500)
            m = await st(pg)
            check(m['v'] == 2 and m['formId'] == want_form and m['stage'] == want_stage and not m['dead'] and m['xp'] > 0
                  and m['ageMs'] >= await ev(pg, f"Tama.Evolution.entryAge('{want_form}')"),
                  f"v1 save ({old['formId']}) migrates to {m['formId']}/{m['stage']} Lv{await ev(pg, 'Tama.Pet.level(Tama.Game.state)')}")
        await ctx.close()

        # ================= 3. online: two real players, tap-only =================
        ctxA, A = await new_page(browser, PHONE, 'A'); ctxB, B = await new_page(browser, PHONE, 'B')
        await fresh(A); await fresh(B)
        await make_pet(A, 'dreadclaw', 'ALICE'); await make_pet(B, 'sludgeking', 'BOB', 's.xp=300;')
        sa0, sb0 = await st(A), await st(B)
        await tap_icon(A, 'battle'); await tap_zone(A, 'opt0')
        check(await mode(A) == 'search', 'RANDOM starts searching')
        await A.wait_for_timeout(1300); await A.screenshot(path=f'{SHOTS}/06-phone-searching.png')
        await tap_icon(B, 'battle'); await tap_zone(B, 'opt0')
        await A.wait_for_function("Tama.Game.ui.battle && Tama.Game.ui.battle.kind==='online'", timeout=6000)
        await B.wait_for_function("Tama.Game.ui.battle && Tama.Game.ui.battle.kind==='online'", timeout=6000)
        check(True, 'two phones matched online')
        oa = await ev(A, "Tama.Game.ui.battle.opp.card"); ob = await ev(B, "Tama.Game.ui.battle.opp.card")
        check(oa['formId'] == 'sludgeking' and oa['name'] == 'BOB' and ob['formId'] == 'dreadclaw' and ob['name'] == 'ALICE' and oa.get('xp') == 300,
              f'each player sees the other real pet ({oa["name"]}/{oa["formId"]} vs {ob["name"]}/{ob["formId"]})')
        await A.wait_for_function("Tama.Game.ui.battle.phase==='choose'", timeout=8000)
        await B.wait_for_function("Tama.Game.ui.battle.phase==='choose'", timeout=8000)
        roles = [await ev(A, 'Tama.Game.ui.battle.role'), await ev(B, 'Tama.Game.ui.battle.role')]
        check(sorted(roles) == ['atk', 'def'], f'server assigns attacker/defender roles {roles}')
        await A.wait_for_timeout(800)
        await A.screenshot(path=f'{SHOTS}/04-phone-online-battle.png')
        check(await ev(A, 'document.body.dataset.env') == 'battle', 'battles use the Gen-3 battle field')
        ok = await fight_by_tapping([A, B], shot=f'{SHOTS}/04b-phone-online-battle-hit.png')
        check(ok, 'online battle finished (both players tapping)')
        sa, sb = await st(A), await st(B)
        check(sa['battles'] == sa0['battles'] + 1 and sb['battles'] == sb0['battles'] + 1, 'both pets recorded the battle')
        check(sa['xp'] > sa0['xp'] and sb['xp'] > sb0['xp'], f"both pets gained XP online (+{sa['xp'] - sa0['xp']} / +{sb['xp'] - sb0['xp']})")
        check((sa['wins'] - sa0['wins']) + (sb['wins'] - sb0['wins']) == 1, 'exactly one winner')
        log = open('/tmp/tama-node.log').read()
        check('ALICE' in log and 'winner' in log, 'server resolved the battle (log)')

        # ================= 4. anti-cheat: raw WebSocket clients =================
        res = await ev(A, """new Promise(async (done) => {
          const url = 'ws://' + location.host + '/ws', out = {};
          const open = () => new Promise(r => { const w = new WebSocket(url); w.onopen = () => r(w); });
          const next = (w, t) => new Promise(r => { const h = (e) => { const m = JSON.parse(e.data); if (!t || m.t === t) { w.removeEventListener('message', h); r(m); } }; w.addEventListener('message', h); });
          const w1 = await open();
          w1.send(JSON.stringify({t:'find', card:{name:'HAX',formId:'drakon',training:0,wins:0,battles:0,weight:30}, ageMs: 1000}));
          out.tooYoung = (await next(w1)).reason;
          w1.send(JSON.stringify({t:'find', card:{name:'HAX',formId:'kingleo',training:0,wins:0,battles:0,weight:30}, ageMs: 3*86400e3}));
          out.adultTooYoung = (await next(w1)).reason;
          w1.send(JSON.stringify({t:'find', card:{name:'HAX',formId:'vesper',training:0,wins:0,battles:0,weight:20}, ageMs: 86400e3}));
          out.teenTooYoung = (await next(w1)).reason;
          w1.send(JSON.stringify({t:'find', card:{name:'HAX',formId:'kingleo',training:0,wins:50,battles:1,weight:30}, ageMs: 6*86400e3}));
          out.badCounters = (await next(w1)).reason;
          w1.send(JSON.stringify({t:'find', card:{name:'HAX',formId:'kingleo',xp:13230,training:2,wins:1,battles:1,weight:30}, ageMs: 6*86400e3}));
          out.badXp = (await next(w1)).reason;
          w1.send(JSON.stringify({t:'find', card:{name:'HAX',formId:'kingleo',xp:0,training:0,wins:0,battles:0,weight:30,hp:999,pow:99}, ageMs: 6*86400e3, hp: 999}));
          await next(w1, 'searching');
          const w2 = await open();
          w2.send(JSON.stringify({t:'find', card:{name:'PAL',formId:'blob',xp:40,training:2,wins:0,battles:0,weight:8}, ageMs: 2e5}));
          const m1 = await next(w1, 'matched'); const t1 = await next(w1, 'turn'); await next(w2, 'turn');
          out.hp = m1.you.hp;
          w1.send(JSON.stringify({t:'move', dir:'hi', n: 999})); w1.send(JSON.stringify({t:'move', dir:'nuke', n: t1.n}));
          w1.send(JSON.stringify({t:'result', res:{hit:true,dmg:99}}));
          let early = null; const h = (e) => { const m = JSON.parse(e.data); if (m.t === 'result') early = m; }; w1.addEventListener('message', h);
          await new Promise(r => setTimeout(r, 500));
          out.ignored = early === null;
          w1.send(JSON.stringify({t:'move', dir:'hi', n: t1.n})); w1.send(JSON.stringify({t:'move', dir:'lo', n: t1.n}));
          w2.send(JSON.stringify({t:'move', dir:'lo', n: t1.n}));
          const r = await next(w1, 'result'); out.dmg = r.res.dmg; out.hpAfter = r.hp;
          w1.close(); w2.close(); done(out);
        })""")
        check(res['tooYoung'] == 'form does not match age', f"server rejects a secret form on a young pet ({res['tooYoung']})")
        check(res['adultTooYoung'] == 'form does not match age' and res['teenTooYoung'] == 'form does not match age',
              f"server rejects a final form before day 5 / a day-2 form before day 2 ({res['adultTooYoung']}, {res['teenTooYoung']})")
        check(res['badXp'] == 'implausible XP', f"server rejects XP that training/battles can't explain ({res['badXp']})")
        check(res['badCounters'] == 'more wins than battles', f"server rejects impossible counters ({res['badCounters']})")
        check(res['hp'] == 5, f"client-sent hp:999 ignored, server uses KAISERON's (kingleo) own HP ({res['hp']})")
        check(res['ignored'], 'forged results / wrong-turn / invalid moves are ignored')
        check(res['dmg'] <= 3, f"damage computed by server ({res['dmg']}), hp now {res['hpAfter']}")

        # ================= 5. fallback: nobody else online =================
        await make_pet(A, 'nekoru', 'ALICE')
        await tap_icon(A, 'battle'); await tap_zone(A, 'opt0')
        t0 = time.time()
        await A.wait_for_function("Tama.Game.ui.fallbackReason==='nomatch'", timeout=20000)
        check(10 <= time.time() - t0 <= 16, f'no opponent -> gives up after ~12 s ({time.time()-t0:.1f}s)')
        await A.wait_for_timeout(900); await A.screenshot(path=f'{SHOTS}/07-phone-no-rival-fallback.png')
        await A.wait_for_function("Tama.Game.ui.battle && Tama.Game.ui.battle.kind==='cpu'", timeout=5000)
        check(True, 'falls back to a CPU rival (NO RIVAL / VS CPU shown)')
        await fight_by_tapping([A])
        await ctxA.close(); await ctxB.close()

        # ================= 6. fallback: server stopped (static host) & file:// =================
        stop(node); node = None
        static = start_static()
        ctx, pg = await new_page(browser, PHONE, 'static')
        await fresh(pg); await make_pet(pg, 'blobbo', 'SOLO')
        await tap_icon(pg, 'battle'); await tap_zone(pg, 'opt0')
        await pg.wait_for_function("Tama.Game.ui.fallbackReason==='offline'", timeout=8000)
        await pg.wait_for_timeout(900)
        await pg.wait_for_function("Tama.Game.ui.battle && Tama.Game.ui.battle.kind==='cpu'", timeout=5000)
        check(True, 'server unreachable -> OFFLINE / VS CPU fallback')
        await ctx.close(); stop(static)
        # the failed WebSocket handshake itself is logged by Chrome as a console error; expected here
        errors[:] = [e for e in errors if not (e.startswith('static') and 'WebSocket' in e)]

        ctx, pg = await new_page(browser, PHONE, 'file')
        url = 'file://' + os.path.join(ROOT, 'index.html')
        await fresh(pg, url); await make_pet(pg, 'blobbo', 'FILE')
        await tap_icon(pg, 'battle'); await tap_zone(pg, 'opt0')
        await pg.wait_for_function("Tama.Game.ui.fallbackReason==='offline'", timeout=6000)
        await pg.wait_for_function("Tama.Game.ui.battle && Tama.Game.ui.battle.kind==='cpu'", timeout=5000)
        check(True, 'file:// -> RANDOM falls back to CPU')
        await ctx.close()

        # ================= evolution tree gallery (debug panel, whole tree) =================
        ctx, pg = await new_page(browser, dict(PHONE, viewport={'width': 430, 'height': 900}), 'tree')
        await fresh(pg, 'file://' + os.path.join(ROOT, 'index.html') + '?debug=1')
        await ev(pg, "Tama.Debug.gallery()")
        n = await ev(pg, "document.querySelectorAll('#gallery .gal-cell').length")
        check(n == 2 + 6 + 12 + 1, f'debug gallery shows the whole tree ({n} forms)')
        await pg.add_style_tag(content='html,body{height:auto!important;overflow:visible!important} #scene,.bar,#debug{display:none!important} #gallery{position:static!important;inset:auto!important;border:0}')
        await pg.wait_for_timeout(300); await pg.screenshot(path=f'{SHOTS}/08-evolution-tree.png', full_page=True)
        # force a branch from the debug panel (with its preview)
        await fresh(pg, 'file://' + os.path.join(ROOT, 'index.html') + '?debug=1')
        await ev(pg, "document.querySelector('#debug').classList.remove('collapsed')")
        await ev(pg, "Tama.Debug.force('blob'); Tama.Debug.info(document.getElementById('debug'))")
        opts = await ev(pg, "[...document.querySelectorAll('#dbgBranch option')].map(function(o){return o.value})")
        check(opts == ['muck', 'vesper', 'scrapper', 'blobbo', 'nekoru', 'kuchibo'], f'debug lists the branches of the current form {opts}')
        await pg.select_option('#dbgBranch', 'muck'); await pg.locator('[data-d="force"]').click(); await pg.wait_for_timeout(300)
        check((await st(pg))['formId'] == 'muck' and await ev(pg, "!!Tama.Game.ui.anim"), 'debug can force a branch (with the evolution animation)')
        await ctx.close()
        await browser.close()
    stop(node)
    print('\nconsole errors/warnings:', errors)
    if errors: fails.append('console errors')
    print('FAILURES:', fails)
    sys.exit(1 if fails else 0)

asyncio.run(main())
