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
    await ev(pg, f"""(function(){{var s=Tama.Game.state; s.eggMs=Tama.CONFIG.T.HATCH; Tama.Pet.simulate(s,1000);
      Tama.Pet.evolve(s,'{form}'); var st=Tama.FORMS['{form}'].stage;
      s.ageMs={{child:Tama.CONFIG.T.CHILD_AT,teen:Tama.CONFIG.T.TEEN_AT,adult:Tama.CONFIG.T.ADULT_AT,secret:Tama.CONFIG.T.SECRET_AT}}[st]+2000;
      s.name='{name}'; s.hunger=4; s.happy=4; s.training=6; s.battles=3; s.wins=2; s.poops=[]; s.sick=false; s.dead=false; {extra}
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

        await ev(pg, "Tama.Game.state.eggMs=Tama.CONFIG.T.HATCH-200")
        await pg.wait_for_function("Tama.Game.state.stage==='baby'", timeout=4000); await idle(pg)
        check((await st(pg))['formId'] == 'pixbit', 'hatched')

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
        check((await st(pg))['plays'] == 1, 'play game completed by tapping')

        await tap_icon(pg, 'status'); check(await mode(pg) == 'status', 'STATUS icon opens status')
        await pg.wait_for_timeout(200)
        await pg.screenshot(path=f'{SHOTS}/03-phone-status-overlay.png')
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
        await ev(pg, "var s=Tama.Game.state; s.ageMs=Math.floor(s.ageMs/Tama.CONFIG.T.DAY)*Tama.CONFIG.T.DAY+Tama.CONFIG.T.DAY*Tama.CONFIG.T.NIGHT_FRAC+10")
        await pg.wait_for_timeout(300)
        await tap_icon(pg, 'light'); await tap_zone(pg, 'opt1')
        s = await st(pg); check(s['asleep'] and s['lightsOff'], 'LIGHT icon -> OFF turns lights off while asleep')
        check(await ev(pg, "document.body.dataset.env") == 'night', 'lights off switches the meadow to the night sky')
        await pg.wait_for_timeout(700); await pg.screenshot(path=f'{SHOTS}/02-phone-night.png')
        await ev(pg, "Tama.Game.state.ageMs=20000"); await pg.wait_for_timeout(300)

        await tap_zone(pg, 'pet')
        check(await ev(pg, "Tama.Game.ui.petted > performance.now()"), 'tapping the pet makes it react')

        await make_pet(pg, 'scrapper', 'PIPO', "s.poops=[{age:0,counted:false}];")
        await ev(pg, "var u=Tama.Game.ui; u.pet.x=10; u.pet.move='hop'; u.emote='heart'; u.emoteUntil=performance.now()+1e9; u.nextThink=performance.now()+1e9;")
        await pg.wait_for_timeout(400); await pg.screenshot(path=f'{SHOTS}/01-phone-home-day.png')
        check(await ev(pg, "document.body.dataset.env") == 'day', 'daytime meadow')
        await ev(pg, "Tama.Game.ui.nextThink=0; Tama.Game.ui.emote=null")

        await tap_icon(pg, 'battle'); check(await mode(pg) == 'battleMenu', 'BATTLE icon opens RANDOM/FRIEND/CPU menu')
        await pg.wait_for_timeout(200); await pg.screenshot(path=f'{SHOTS}/05-phone-battle-menu.png')
        b0 = (await st(pg))['battles']
        await tap_zone(pg, 'opt2')
        check(await ev(pg, "Tama.Game.ui.battle && Tama.Game.ui.battle.kind") == 'cpu', 'CPU option starts a computer battle')
        check(await fight_by_tapping([pg]), 'CPU battle played to the end by tapping HI/LO')
        check((await st(pg))['battles'] == b0 + 1, 'CPU battle recorded')

        code = await ev(pg, "Tama.Battle.encode({name:'RIVAL',formId:'kingleo',training:9,wins:7,battles:9,weight:33})")
        await tap_icon(pg, 'battle'); await tap_zone(pg, 'opt1')
        check(await ev(pg, "!document.getElementById('linkPanel').hidden"), 'FRIEND option opens the friend-code sheet')
        my = await pg.inner_text('#myCode')
        check(await ev(pg, f"(Tama.Battle.decode({json.dumps(my)})||{{}}).formId") == 'scrapper', 'sheet shows own code with species')
        await pg.fill('#friendCode', 'TP-nonsense'); await pg.locator('#linkFight').tap()
        check('look right' in await pg.inner_text('#linkError'), 'bad friend code shows an error')
        await pg.fill('#friendCode', code); await pg.wait_for_timeout(100)
        pass
        await pg.locator('#linkFight').tap(); await pg.wait_for_timeout(200)
        check(await ev(pg, "Tama.Game.ui.battle && Tama.Game.ui.battle.opp.card.formId") == 'kingleo', 'friend battle uses the code species')
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
        forms = set()
        for v in [dict(careMistakes=1, training=10, battles=8, wins=7, discipline=25, meals=20, snacks=5, weight=30),
                  dict(careMistakes=1, training=2, battles=0, wins=0, discipline=100, meals=20, snacks=4, weight=25),
                  dict(careMistakes=4, training=0, battles=0, wins=0, discipline=0, meals=5, snacks=20, weight=50),
                  dict(careMistakes=9, training=0, battles=0, wins=0, discipline=0, meals=10, snacks=3, weight=25)]:
            forms.add((await ev(pg, f"Tama.Debug.runScenario({json.dumps(v)})"))['form'])
        check(forms == {'kingleo', 'starla', 'chubbo', 'ghoulie'}, f'evolution rules unchanged {forms}')
        await ctx.close()

        # ================= 3. online: two real players, tap-only =================
        ctxA, A = await new_page(browser, PHONE, 'A'); ctxB, B = await new_page(browser, PHONE, 'B')
        await fresh(A); await fresh(B)
        await make_pet(A, 'nekoru', 'ALICE'); await make_pet(B, 'scrapper', 'BOB')
        sa0, sb0 = await st(A), await st(B)
        await tap_icon(A, 'battle'); await tap_zone(A, 'opt0')
        check(await mode(A) == 'search', 'RANDOM starts searching')
        await A.wait_for_timeout(1300); await A.screenshot(path=f'{SHOTS}/06-phone-searching.png')
        await tap_icon(B, 'battle'); await tap_zone(B, 'opt0')
        await A.wait_for_function("Tama.Game.ui.battle && Tama.Game.ui.battle.kind==='online'", timeout=6000)
        await B.wait_for_function("Tama.Game.ui.battle && Tama.Game.ui.battle.kind==='online'", timeout=6000)
        check(True, 'two phones matched online')
        oa = await ev(A, "Tama.Game.ui.battle.opp.card"); ob = await ev(B, "Tama.Game.ui.battle.opp.card")
        check(oa['formId'] == 'scrapper' and oa['name'] == 'BOB' and ob['formId'] == 'nekoru' and ob['name'] == 'ALICE',
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
          w1.send(JSON.stringify({t:'find', card:{name:'HAX',formId:'kingleo',training:0,wins:50,battles:1,weight:30}, ageMs: 2e6}));
          out.badCounters = (await next(w1)).reason;
          w1.send(JSON.stringify({t:'find', card:{name:'HAX',formId:'kingleo',training:0,wins:0,battles:0,weight:30,hp:999,pow:99}, ageMs: 2e6, hp: 999}));
          await next(w1, 'searching');
          const w2 = await open();
          w2.send(JSON.stringify({t:'find', card:{name:'PAL',formId:'mochi',training:0,wins:0,battles:0,weight:10}, ageMs: 2e5}));
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

        # ================= adult & secret forms gallery (rendered in-game, phone scale) =================
        ctx, pg = await new_page(browser, PHONE, 'gallery')
        await fresh(pg, 'file://' + os.path.join(ROOT, 'index.html')); await pg.add_style_tag(content='.bar{display:none !important}')
        tiles = []
        for fid in ['kingleo', 'rokkun', 'starla', 'mimiko', 'chubbo', 'ghoulie', 'oyaji', 'drakon', 'seraphi']:
            await make_pet(pg, fid, 'PIX')
            await ev(pg, "var u=Tama.Game.ui, w=Tama.Game.scene.size(Tama.Game.state.formId).w; u.pet.x=Math.round((96-w)/2); u.pet.move='stay'; u.nextThink=performance.now()+1e9; u.emote=null;")
            await pg.wait_for_timeout(350)
            a = await ev(pg, "Tama.Game.stageToClient(22,2)"); b2 = await ev(pg, "Tama.Game.stageToClient(74,50)")
            path = f'/tmp/tile_{fid}.png'
            await pg.screenshot(path=path, clip={'x': a['x'], 'y': a['y'], 'width': b2['x'] - a['x'], 'height': b2['y'] - a['y']})
            info = await ev(pg, f"({{n:Tama.FORMS['{fid}'].name, d:Tama.FORMS['{fid}'].desc, s:Tama.FORMS['{fid}'].stage}})")
            tiles.append((info, path))
        await ctx.close()
        pg = await browser.new_page(viewport={'width': 390, 'height': 844}, device_scale_factor=2)
        cells = ''.join(f'<figure><img src="data:image/png;base64,{base64.b64encode(open(path,"rb").read()).decode()}"><figcaption><b>{i["n"]}</b><span>{i["d"]}</span></figcaption></figure>' for i, path in tiles)
        await pg.set_content(f'''<html><body style="margin:0;background:#11161f;font-family:ui-monospace,Menlo,Consolas,monospace;color:#e6ebf2">
        <h1 style="text-align:center;color:#e0ad48;margin:16px 0 2px;font-size:17px;letter-spacing:3px">TAMA·PIX</h1>
        <p style="text-align:center;color:#8e9bb0;margin:0 0 12px;font-size:12px">7 adult forms + 2 secret forms</p>
        <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:10px;padding:0 12px 16px">{cells}</div>
        <style>figure{{margin:0;display:flex;flex-direction:column;background:#161c28;border:1px solid #8d9db5;box-shadow:0 0 0 1px #0a0d13;border-radius:3px;overflow:hidden}}
        img{{width:100%;image-rendering:pixelated;display:block}} figcaption{{padding:6px 8px 8px;display:flex;flex-direction:column;gap:2px}}
        b{{letter-spacing:2px;font-size:13px}} span{{color:#8e9bb0;font-size:10.5px}}</style></body></html>''')
        await pg.wait_for_timeout(300); await pg.screenshot(path=f'{SHOTS}/08-adult-forms-gallery.png', full_page=True)
        await browser.close()
    stop(node)
    print('\nconsole errors/warnings:', errors)
    if errors: fails.append('console errors')
    print('FAILURES:', fails)
    sys.exit(1 if fails else 0)

asyncio.run(main())
