/* TAMA-PIX — monster & prop sprites, built from shaded parts (GBA-style).
 *
 * Every creature is a list of simple parts drawn back-to-front on a 40x40 canvas, facing LEFT:
 *   E(x,y,rx,ry,mat)            ellipse (opt. a = rotation)            -> sphere-like shading
 *   C(x1,y1,x2,y2,r1,r2,mat)    tapered capsule (limbs, horns, claws)   -> cylinder-like shading
 *   P([[x,y]...],mat)           polygon (armour, wings, manes)          -> bevel shading
 *   R(x,y,rx,ry,th,mat)         ellipse ring (halo)
 * then small features on top (eyes, teeth, glow marks). The rasteriser gives each part 4 tones from its material
 * ramp (light from the top-left), draws a dark line where a part overlaps the one behind it, and a dark outline
 * around the silhouette. Part groups animate the 2-frame idle: b body / h head / a arms breathe down 1px,
 * t tail sways, w wings flap, l legs stay planted.
 */
(function (T) {
  'use strict';

  // 4-tone ramps, dark -> light (muted, natural)
  const RAMP = {
    crimson: ['#3a1216', '#65201f', '#93352a', '#bf5a3e'],
    wine:    ['#26090f', '#461419', '#6a2323', '#8f3a30'],
    ember:   ['#4d200f', '#823915', '#b65e1f', '#dc8a3a'],
    gold:    ['#453012', '#735318', '#a5802a', '#d1b457'],
    bone:    ['#463e32', '#7a6d57', '#ac9f80', '#d8cfb3'],
    ivory:   ['#4f4a40', '#838071', '#b6b1a0', '#e0dccd'],
    slate:   ['#141a27', '#243047', '#3a4d6b', '#5d7596'],
    steel:   ['#1f232b', '#383f4b', '#58626f', '#848f9e'],
    stone:   ['#27241f', '#433e36', '#655d51', '#8c8373'],
    moss:    ['#172113', '#28391e', '#415a2a', '#667f41'],
    teal:    ['#0e2527', '#1b4242', '#2c6560', '#52938a'],
    violet:  ['#170f22', '#2d1f42', '#483363', '#6e548c'],
    shadow:  ['#0d0d12', '#1a1a22', '#2b2b37', '#454555'],
    fur:     ['#2a1a12', '#4a2f20', '#704b32', '#9c7250'],
    sand:    ['#443621', '#735e3d', '#9f875d', '#c9b287'],
    silver:  ['#40475a', '#6e778b', '#9ea7b8', '#d2d8e2'],
    azure:   ['#0e1c36', '#1b355e', '#2e5389', '#5580b3'],
    ice:     ['#1f4050', '#3a6f80', '#62a2b0', '#a6dce0'],
    rock:    ['#23221f', '#3d3b36', '#5d5a52', '#858176'],
    dirt:    ['#2c2016', '#4a3624', '#6a5038', '#8a6c4c'],
    sludge:  ['#1a170c', '#322c17', '#4f4524', '#716338'],
    toxic:   ['#15230b', '#2b4413', '#4c6b1b', '#7c9a2c'],
    gel:     ['#0f1a1f', '#1c3238', '#2e5057', '#4f7c7e']
  };
  const GLOW = { amber: '#ffc437', red: '#ff4130', cyan: '#72f0ff', violet: '#e19bff', white: '#f4f6ff', ember: '#ff8a26', green: '#9dff6a' };
  const OUT = '#08080c';

  const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  const toHex = (c) => '#' + c.map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
  const mix = (a, b, t) => { const A = hex(a), B = hex(b); return toHex(A.map((v, i) => v + (B[i] - v) * t)); };

  // ---------------------------------------------------------------- part constructors
  const E = (x, y, rx, ry, m, g, o) => Object.assign({ t: 'e', x, y, rx, ry, m, g: g || 'b', a: 0 }, o);
  const C = (x1, y1, x2, y2, r1, r2, m, g, o) => Object.assign({ t: 'c', x1, y1, x2, y2, r1, r2, m, g: g || 'b' }, o);
  const P = (pts, m, g, o) => Object.assign({ t: 'p', pts, m, g: g || 'b' }, o);
  const R = (x, y, rx, ry, th, m, g, o) => Object.assign({ t: 'r', x, y, rx, ry, th, m, g: g || 'b' }, o);
  const star = (cx, cy, rIn, rOut, n, rot, sx) => {
    const pts = [];
    for (let i = 0; i < n * 2; i++) {
      const r = i % 2 ? rIn : rOut, a = rot + i * Math.PI / n;
      pts.push([cx + Math.cos(a) * r * (sx || 1), cy + Math.sin(a) * r]);
    }
    return pts;
  };
  // features: fierce eye (facing left), pixels
  const EYE = (x, y, glow, g) => ({ f: 'eye', x, y, c: GLOW[glow] || glow, g: g || 'h' });
  const PX = (pts, c, g) => ({ f: 'px', pts, c, g: g || 'h' });

  // ---------------------------------------------------------------- designs (facing left, ground = y 39)
  const D = {};
  D.egg = () => [
    E(20, 29, 8, 10, 'slate'),
    C(15, 23, 17, 25, 1.4, 1.2, 'azure', 'b', { nl: 1 }), C(24, 31, 26, 33, 1.6, 1.3, 'azure', 'b', { nl: 1 }), C(21, 21, 22, 22, 1, 1, 'azure', 'b', { nl: 1 }),
    C(16, 33, 17, 34, 1, 1, 'azure', 'b', { nl: 1 }),
    PX([[19, 21], [20, 22], [19, 23], [20, 24], [21, 25], [20, 26]], 'glowpulse', 'b')
  ];
  D.blob = () => [             // BLOB: the amorphous stage-1 form every pet hatches into (wobbles: parts shift per frame)
    E(20, 37.6, 10, 2.2, 'gel', 'l'),
    C(12, 34, 11, 37.5, 1.2, 0.9, 'gel', 'l'), C(29, 35, 30, 37.8, 1.1, 0.8, 'gel', 'l'),
    E(20, 33, 9, 5.5, 'gel', 'l'),
    E(26, 32, 4.5, 4, 'gel', 't'),
    E(19, 28.5, 6.5, 5.5, 'gel', 'b'),
    E(22, 23.5, 2.2, 2.4, 'gel', 'w'),
    E(24, 34.5, 3, 1.6, 'shadow', 'l', { nl: 1 }), PX([[24, 34]], 'glowpulse:violet', 'l'), PX([[13, 33], [27, 36]], 'gel:0', 'l'),
    PX([[16, 25], [17, 24], [18, 24], [23, 22]], 'ice:2', 'b'), PX([[27, 30]], 'ice:2', 't'),
    EYE(15, 28, 'amber', 'b'), EYE(19.5, 28, 'amber', 'b')
  ];
  D.pixbit = () => [           // FANGLET (unused since the BLOB update; kept for old art)
    C(27, 34, 35, 30, 2.4, 0.6, 'slate', 't'), C(35, 30, 37, 26, 0.9, 0.3, 'slate', 't'),
    C(27, 35, 28, 39, 1.8, 1.5, 'slate', 'l'),
    E(23, 33, 6.5, 4.2, 'slate'),
    E(22, 36, 4.5, 1.4, 'sand', 'b', { nl: 1 }),
    C(18, 35, 17, 39, 1.8, 1.5, 'slate', 'l'),
    C(24, 29, 25, 27, 1, 0.2, 'bone', 'b'), C(28, 30, 29, 28, 0.9, 0.2, 'bone', 'b'),
    E(15, 29, 5.2, 4.3, 'slate', 'h'),
    C(12, 31, 8, 32, 2.6, 1.6, 'slate', 'h'),
    C(17, 26, 21, 21, 1.3, 0.25, 'bone', 'h'), C(14, 26, 14, 22, 1, 0.25, 'bone', 'h'),
    EYE(12, 29, 'amber'),
    PX([[8, 33], [10, 33]], 'bone:3'), PX([[16, 39], [18, 39], [27, 39]], 'bone:2', 'l')
  ];
  D.mochi = () => [            // VULPEX: ember fox-beast pup
    C(30, 33, 36, 24, 3.4, 2.2, 'ember', 't'), C(36, 24, 34, 16, 2.4, 0.3, 'ember', 't'), C(36, 22, 35, 18, 1.4, 0.3, 'bone', 't', { nl: 1 }),
    C(29, 33, 30, 39, 2, 1.4, 'fur', 'l'), C(22, 34, 23, 39, 1.7, 1.3, 'fur', 'l'),
    E(25, 31, 7, 4.8, 'ember'),
    E(18, 32, 3.4, 4, 'ivory', 'b'),
    C(18, 34, 17, 39, 1.8, 1.4, 'ember', 'l'),
    E(15, 24, 5, 4.4, 'ember', 'h'),
    C(12, 26, 7, 27.5, 2.6, 1, 'ember', 'h'),
    P([[15, 26], [21, 28], [16, 30]], 'ivory', 'h'),
    C(17, 21, 20, 13, 2.2, 0.3, 'ember', 'h'), C(13, 21, 12, 14, 1.9, 0.3, 'ember', 'h'),
    C(17.5, 20, 19, 15, 0.8, 0.2, 'wine', 'h', { nl: 1 }),
    EYE(12, 24, 'amber'),
    PX([[7, 27]], OUT), PX([[9, 29], [10, 29], [11, 29]], OUT), PX([[9, 30]], 'ivory:3'),
    PX([[16, 39], [18, 39], [29, 39]], 'bone:2', 'l')
  ];
  D.kuchibo = () => [          // GNASHER: big-jawed swamp reptile
    C(28, 35, 38, 37, 3, 0.7, 'moss', 't'),
    C(26, 34, 27, 39, 2.5, 2, 'moss', 'l'),
    E(23, 30, 7, 7, 'moss'),
    E(20, 32, 4, 5, 'sand', 'b'),
    C(24, 23, 26, 18, 1.2, 0.2, 'bone', 'b'), C(28, 25, 31, 21, 1.2, 0.2, 'bone', 'b'), C(30, 28, 34, 26, 1, 0.2, 'bone', 'b'),
    C(20, 35, 19, 39, 2.6, 2, 'moss', 'l'),
    C(16, 29, 12, 32, 1.6, 1.1, 'moss', 'a'), C(12, 32, 10, 34, 0.8, 0.2, 'bone', 'a'),
    E(18, 21, 6, 4.8, 'moss', 'h'),
    C(20, 17, 21, 13, 1.2, 0.2, 'bone', 'h'),
    P([[8, 24], [20, 25], [18, 29], [11, 28]], 'moss', 'h'),
    PX([[10, 25], [11, 25], [12, 25], [13, 25], [14, 25], [15, 25], [16, 25], [17, 25]], 'wine:1'),
    PX([[9, 24], [11, 24], [13, 24], [15, 24], [12, 26], [14, 26], [16, 26]], 'ivory:3'),
    EYE(15, 20, 'red'),
    PX([[18, 39], [20, 39], [26, 39]], 'bone:2', 'l')
  ];
  D.nekoru = () => [           // LYNXAR: prowling lynx beast
    C(32, 30, 38, 25, 2.2, 1.6, 'sand', 't'), C(38, 25, 39, 20, 1.7, 0.4, 'shadow', 't'),
    C(29, 32, 31, 39, 2, 1.5, 'fur', 'l'), C(16, 32, 15, 39, 1.8, 1.4, 'fur', 'l'),
    E(24, 30, 9, 5, 'sand', 'b', { a: 0.05 }),
    PX([[23, 26], [24, 27], [27, 26], [28, 27], [20, 26], [31, 27], [26, 29]], 'fur:1', 'b'),
    E(30, 31, 4.5, 5, 'sand', 'l'), C(31, 35, 29, 39, 2, 1.7, 'sand', 'l'),
    P([[13, 28], [19, 27], [19, 34], [14, 33]], 'ivory', 'b'),
    C(18, 31, 19, 39, 2.1, 1.8, 'sand', 'l'),
    E(13, 25, 5.5, 4.5, 'sand', 'h'),
    E(8.5, 27, 3, 2.3, 'ivory', 'h'),
    P([[14, 27], [20, 25], [20, 31]], 'ivory', 'h'),
    C(15, 21, 17, 15, 2, 0.3, 'sand', 'h'), C(11, 21, 10, 16, 1.7, 0.3, 'sand', 'h'),
    PX([[17, 14], [17, 13], [18, 12], [10, 15], [10, 14]], 'shadow:1'),
    EYE(10, 24, 'amber'),
    PX([[6, 26]], OUT), PX([[7, 28], [8, 28]], OUT), PX([[7, 29]], 'ivory:3'),
    PX([[17, 39], [18, 39], [20, 39], [29, 39]], 'ivory:2', 'l')
  ];
  D.scrapper = () => [         // TALONIX: raptor brawler
    C(28, 27, 39, 23, 3, 0.6, 'crimson', 't'),
    C(28, 29, 31, 34, 3, 2, 'crimson', 'l'), C(31, 34, 29, 39, 2, 1.3, 'crimson', 'l'),
    E(23, 25, 6, 7, 'crimson', 'b', { a: 0.4 }),
    E(20, 28, 3, 4, 'sand', 'b'),
    E(24, 31, 4, 4, 'crimson', 'l'), C(24, 33, 21, 39, 2, 1.3, 'crimson', 'l'),
    C(18, 24, 13, 27, 1.7, 1.2, 'crimson', 'a'), C(13, 27, 10, 29, 1, 0.2, 'bone', 'a'), C(13, 27, 11, 31, 1, 0.2, 'bone', 'a'),
    E(16, 16, 5, 4, 'crimson', 'h'),
    C(13, 17, 6, 18.5, 3, 1.4, 'crimson', 'h'),
    C(18, 13, 27, 8, 2.2, 0.4, 'bone', 'h'), C(17, 13, 22, 6, 1.6, 0.3, 'bone', 'h'),
    EYE(13, 15, 'amber'),
    PX([[7, 20], [8, 20], [9, 20], [10, 20], [11, 20]], OUT), PX([[8, 21], [10, 21]], 'ivory:3'),
    PX([[19, 39], [20, 39], [22, 39], [28, 39], [30, 39]], 'bone:2', 'l')
  ];
  D.blobbo = () => [           // MIREBACK: moss-shelled swamp brute
    C(30, 32, 32, 39, 3, 2.5, 'teal', 'l'),
    E(22, 32, 9, 5, 'teal'),
    E(25, 26, 10, 7, 'moss'),
    C(21, 20, 22, 16, 1.3, 0.3, 'stone', 'b'), C(26, 19, 28, 15, 1.4, 0.3, 'stone', 'b'), C(31, 21, 34, 18, 1.3, 0.3, 'stone', 'b'),
    PX([[22, 25], [23, 26], [27, 23], [30, 27], [26, 29], [19, 28]], 'moss:3', 'b'),
    C(16, 31, 15, 39, 3, 2.5, 'teal', 'l'),
    E(12, 28, 6, 4.4, 'teal', 'h'),
    E(11, 31, 5.5, 2, 'sand', 'h'),
    EYE(10, 27, 'amber'),
    PX([[6, 30], [7, 30], [8, 30], [9, 30], [10, 30], [11, 30], [12, 30]], OUT),
    PX([[13, 39], [15, 39], [17, 39], [30, 39]], 'bone:2', 'l')
  ];
  D.kingleo = () => [          // KAISERON: crowned lion-dragon
    C(32, 31, 39, 22, 2.4, 1, 'gold', 't'), C(39, 22, 38, 16, 2.4, 0.3, 'crimson', 't'),
    C(24, 31, 25, 39, 2.5, 2.2, 'gold', 'l'),
    E(31, 31, 5, 6, 'gold', 'l'), C(31, 35, 29, 39, 2.5, 2, 'gold', 'l'),
    E(26, 28, 9, 6.5, 'gold'),
    P(star(16, 19, 8, 13, 11, 0.2), 'wine', 'h'), P(star(15, 19, 6, 10, 9, 0.5), 'crimson', 'h'),
    C(18, 30, 17, 39, 2.8, 2.3, 'gold', 'l'),
    E(14, 20, 6, 5.5, 'gold', 'h'),
    E(9, 23, 3.5, 3, 'ivory', 'h'),
    C(16, 15, 22, 5, 1.7, 0.3, 'bone', 'h'), C(12, 15, 11, 6, 1.4, 0.3, 'bone', 'h'),
    EYE(11, 19, 'amber'),
    PX([[6, 22]], OUT), PX([[7, 25], [8, 25], [9, 25], [10, 25], [11, 25]], OUT), PX([[8, 26], [10, 26]], 'ivory:3'),
    PX([[15, 39], [17, 39], [19, 39], [27, 39], [29, 39]], 'bone:2', 'l')
  ];
  D.rokkun = () => [           // BASTION: rune-cored stone golem
    C(24, 30, 25, 39, 3.6, 3.2, 'stone', 'l'), C(16, 30, 15, 39, 3.6, 3.2, 'stone', 'l'),
    C(31, 16, 33, 27, 3, 3.4, 'stone', 'a'), E(33, 30, 4, 3.6, 'steel', 'a'),
    P([[11, 14], [30, 13], [32, 24], [27, 32], [14, 32], [9, 23]], 'stone'),
    P([[17, 18], [24, 18], [26, 25], [20, 29], [15, 25]], 'steel', 'b'),
    PX([[20, 22], [21, 22], [20, 23], [21, 23], [19, 22], [22, 23], [20, 21], [21, 24]], 'glowpulse:cyan', 'b'),
    PX([[13, 27], [14, 28], [28, 20], [29, 21], [27, 28]], 'cyan', 'b'),
    E(20, 9, 5.5, 4.5, 'steel', 'h'), C(20, 6, 20, 1, 1.6, 0.4, 'stone', 'h'),
    PX([[16, 9], [17, 9], [18, 9], [22, 9], [23, 9], [24, 9]], 'cyan', 'h'),
    E(9, 15, 5, 4, 'steel', 'a'), E(31, 14, 5, 4, 'steel', 'a'),
    C(9, 17, 7, 27, 3, 3.4, 'stone', 'a'), E(7, 30, 4, 3.6, 'steel', 'a'),
    PX([[5, 32], [7, 33], [9, 32]], 'steel:0', 'a')
  ];
  D.starla = () => [           // LUMISTAG: star-antlered stag
    C(34, 24, 36, 20, 1.4, 0.4, 'silver', 't'),
    C(28, 29, 28, 39, 1.8, 1.3, 'slate', 'l'), C(22, 29, 23, 39, 1.8, 1.3, 'slate', 'l'),
    E(26, 26, 9, 5.5, 'azure'),
    C(31, 29, 32, 39, 1.8, 1.3, 'azure', 'l'),
    PX([[24, 24], [28, 27], [31, 24], [21, 27]], 'white', 'b'),
    C(19, 28, 18, 39, 1.8, 1.3, 'azure', 'l'),
    C(19, 24, 15, 16, 3, 2.4, 'azure', 'h'),
    P([[14, 20], [20, 19], [21, 28], [16, 25]], 'silver', 'h'),
    E(13, 15, 4.5, 3.5, 'azure', 'h'), C(11, 16, 6, 18, 2.4, 1.3, 'azure', 'h'),
    C(14, 12, 18, 2, 1.2, 0.4, 'ice', 'h'), C(16.5, 7, 21, 5, 0.9, 0.3, 'ice', 'h'), C(15.5, 9.5, 12, 4, 0.9, 0.3, 'ice', 'h'),
    C(12, 12, 9, 3, 1.1, 0.4, 'ice', 'h'), C(10.5, 7.5, 6, 5, 0.8, 0.3, 'ice', 'h'),
    EYE(11, 14, 'cyan'),
    PX([[6, 18]], OUT),
    PX([[17, 39], [19, 39], [31, 39], [32, 39]], 'shadow:2', 'l')
  ];
  D.mimiko = () => [           // GALEHARE: blade-tailed wind jackal
    C(31, 25, 39, 18, 2.2, 0.3, 'teal', 't'), C(31, 27, 38, 24, 1.6, 0.3, 'silver', 't'),
    C(28, 30, 30, 39, 1.9, 1.4, 'steel', 'l'), C(17, 30, 16, 39, 1.8, 1.3, 'steel', 'l'),
    E(24, 27, 9, 5, 'silver', 'b', { a: -0.1 }),
    P([[18, 23], [30, 22], [32, 25], [20, 25]], 'teal', 'b'),
    E(29, 30, 4, 4.5, 'silver', 'l'), C(30, 33, 32, 39, 1.9, 1.4, 'silver', 'l'),
    C(19, 29, 19, 39, 2, 1.5, 'silver', 'l'),
    P([[14, 21], [21, 21], [20, 29], [15, 27]], 'teal', 'h'),
    E(12, 20, 4.8, 4, 'silver', 'h'), C(9, 21, 3, 22.5, 2.3, 1, 'silver', 'h'),
    C(14, 17, 22, 9, 1.8, 0.4, 'silver', 'h'), C(12, 17, 17, 8, 1.5, 0.3, 'teal', 'h'),
    EYE(10, 19, 'cyan'),
    PX([[3, 22]], OUT), PX([[5, 24], [6, 24], [7, 24]], OUT), PX([[6, 25]], 'ivory:3'),
    PX([[16, 39], [19, 39], [30, 39], [32, 39]], 'bone:2', 'l')
  ];
  D.chubbo = () => [           // BEHEMOTH: tusked colossus
    C(31, 30, 32, 39, 3.6, 3, 'fur', 'l'),
    C(24, 31, 25, 39, 3.2, 2.8, 'shadow', 'l'),
    E(25, 26, 11, 8.5, 'fur'),
    C(22, 18, 23, 14, 1.4, 0.3, 'stone', 'b'), C(27, 18, 29, 14, 1.5, 0.3, 'stone', 'b'), C(32, 20, 35, 17, 1.4, 0.3, 'stone', 'b'),
    E(21, 32, 7, 3, 'sand', 'b'),
    C(16, 31, 15, 39, 3.6, 3, 'fur', 'l'),
    E(11, 27, 5.8, 5.2, 'fur', 'h'),
    C(12, 23, 19, 17, 2, 0.4, 'bone', 'h'), C(10, 23, 4, 17, 1.8, 0.3, 'bone', 'h'),
    C(7, 31, 3, 27, 1.3, 0.3, 'ivory', 'h'),
    EYE(8, 26, 'red'),
    PX([[13, 39], [15, 39], [17, 39], [30, 39], [32, 39]], 'bone:2', 'l')
  ];
  D.ghoulie = () => [          // WRAITH: spectral shade-wolf
    P([[14, 12], [28, 14], [33, 30], [31, 37], [28, 33], [25, 38], [22, 33], [18, 38], [16, 32], [12, 35], [12, 22]], 'violet'),
    PX([[20, 36], [26, 36], [14, 33], [30, 34]], 'violet:3', 'b'),
    C(15, 21, 8, 26, 1.6, 0.9, 'violet', 'a'), C(8, 26, 5, 28, 0.9, 0.2, 'bone', 'a'), C(8, 26, 6, 30, 0.9, 0.2, 'bone', 'a'),
    E(17, 13, 6, 5.5, 'shadow', 'h'),
    C(19, 9, 23, 2, 1.8, 0.3, 'shadow', 'h'), C(15, 9, 14, 2, 1.6, 0.3, 'shadow', 'h'),
    C(14, 15, 7, 17, 2.4, 1, 'shadow', 'h'),
    EYE(12, 12, 'red'), EYE(16, 13, 'red'),
    PX([[8, 18], [10, 18]], 'ivory:3')
  ];
  D.oyaji = () => [            // GRIMTUSK: scarred elder boar
    C(30, 31, 31, 39, 2.8, 2.2, 'shadow', 'l'),
    C(22, 32, 22, 39, 2.6, 2, 'shadow', 'l'),
    E(24, 28, 10, 7, 'fur'),
    P([[15, 21], [18, 16], [21, 19], [24, 15], [26, 19], [29, 16], [31, 21], [21, 24]], 'steel', 'b'),
    C(17, 31, 16, 39, 2.8, 2.2, 'fur', 'l'),
    E(12, 27, 6, 5, 'fur', 'h'),
    C(9, 29, 4, 30, 3, 2.4, 'fur', 'h'), E(3.5, 30, 1.4, 2, 'stone', 'h', { nl: 1 }),
    C(7, 32, 6, 25, 1.3, 0.3, 'ivory', 'h'), C(10, 32, 10, 27, 1.1, 0.3, 'ivory', 'h'),
    PX([[12, 24], [13, 25], [14, 26]], 'crimson:2'),
    EYE(10, 26, 'amber'),
    PX([[14, 39], [16, 39], [18, 39], [30, 39]], 'bone:2', 'l')
  ];
  D.drakon = () => [           // DRAKON: winged crimson dragon (secret)
    P([[24, 20], [34, 4], [39, 14], [36, 22], [30, 24]], 'wine', 'w'), C(24, 20, 34, 4, 1.1, 0.5, 'bone', 'w'),
    C(30, 32, 39, 35, 3, 0.6, 'crimson', 't'),
    C(24, 32, 24, 39, 2.4, 2, 'crimson', 'l'),
    E(29, 31, 5, 5, 'crimson', 'l'), C(29, 35, 27, 39, 2.5, 2, 'crimson', 'l'),
    E(24, 28, 8, 6, 'crimson', 'b', { a: -0.3 }),
    E(20, 30, 4, 5, 'sand', 'b'),
    PX([[18, 28], [19, 28], [20, 28], [21, 28], [17, 31], [18, 31], [19, 31], [20, 31]], 'sand:1', 'b'),
    C(19, 32, 18, 39, 2.6, 2, 'crimson', 'l'),
    P([[25, 23], [25, 7], [31, 0], [37, 7], [36, 15], [31, 24]], 'crimson', 'w'), C(25, 23, 31, 0, 1.4, 0.6, 'bone', 'w'),
    C(30.5, 3, 34, 16, 0.6, 0.4, 'wine', 'w', { nl: 1 }), C(28, 10, 29, 22, 0.6, 0.4, 'wine', 'w', { nl: 1 }),
    C(21, 24, 15, 15, 3.2, 2.6, 'crimson', 'h'),
    C(17, 27, 13, 31, 2, 1.4, 'crimson', 'a'), C(13, 31, 10, 33, 0.9, 0.2, 'bone', 'a'), C(13, 31, 11, 35, 0.9, 0.2, 'bone', 'a'),
    E(13, 13, 5, 4, 'crimson', 'h'), C(10, 14, 3, 16, 2.8, 1.4, 'crimson', 'h'),
    C(15, 10, 23, 5, 1.5, 0.3, 'bone', 'h'), C(13, 10, 16, 3, 1.2, 0.3, 'bone', 'h'),
    EYE(10, 12, 'amber'),
    PX([[3, 15]], 'ember'), PX([[4, 18], [5, 18], [6, 18], [7, 18], [8, 18]], OUT), PX([[5, 19], [7, 19]], 'ivory:3'),
    PX([[16, 39], [18, 39], [20, 39], [26, 39], [28, 39]], 'bone:2', 'l')
  ];
  D.seraphi = () => [          // SERAPHIM: six-winged armoured sentinel (secret)
    P([[20, 16], [38, 4], [36, 12], [39, 14], [34, 20], [37, 23], [26, 24]], 'ivory', 'w'),
    P([[20, 16], [2, 4], [4, 12], [1, 14], [6, 20], [3, 23], [14, 24]], 'ivory', 'w'),
    P([[20, 22], [36, 26], [31, 29], [22, 28]], 'silver', 'w'), P([[20, 22], [4, 26], [9, 29], [18, 28]], 'silver', 'w'),
    C(17, 30, 16, 39, 2.4, 2, 'silver', 'l'), C(23, 30, 24, 39, 2.4, 2, 'silver', 'l'),
    P([[14, 15], [26, 15], [27, 25], [23, 32], [17, 32], [13, 25]], 'silver'),
    P([[17, 17], [23, 17], [22, 25], [20, 27], [18, 25]], 'gold', 'b'),
    PX([[20, 20], [20, 21], [19, 21], [21, 21]], 'cyan', 'b'),
    C(9, 6, 11, 39, 0.8, 0.8, 'gold', 'a'), P([[10, 0], [12, 6], [8, 6]], 'silver', 'a'),
    C(14, 17, 10, 23, 1.8, 1.4, 'silver', 'a'),
    E(20, 11, 4.5, 4.5, 'silver', 'h'), P([[16, 11], [24, 11], [23, 14], [17, 14]], 'gold', 'h'),
    PX([[17, 12], [18, 12], [19, 12], [21, 12], [22, 12], [23, 12]], 'cyan', 'h'),
    R(20, 4, 6, 1.6, 1.1, 'gold', 'h', { nl: 1 })
  ];
  D.vesper = () => [           // VESPERAN: young dark angel (day-2, many wins)
    P([[22, 18], [36, 7], [38, 14], [35, 16], [37, 21], [32, 22], [34, 26], [26, 26]], 'shadow', 'w'),
    C(26, 32, 35, 36, 1.6, 0.5, 'violet', 't'), P([[34, 33], [39, 36], [34, 38]], 'violet', 't'),
    C(24, 30, 26, 39, 2, 1.5, 'violet', 'l'),
    E(21, 26, 5, 7, 'violet', 'b', { a: 0.2 }),
    P([[17, 21], [23, 20], [23, 28], [19, 29]], 'steel', 'b'),
    C(19, 31, 18, 39, 2.2, 1.6, 'violet', 'l'),
    P([[20, 17], [29, 3], [33, 8], [30, 11], [33, 14], [28, 16], [31, 20], [24, 23]], 'shadow', 'w'),
    C(28.5, 5, 24, 18, 0.5, 0.4, 'violet', 'w', { nl: 1 }),
    C(17, 22, 12, 28, 1.6, 1.2, 'violet', 'a'), C(12, 28, 9, 30, 0.9, 0.2, 'bone', 'a'), C(12, 28, 10, 32, 0.9, 0.2, 'bone', 'a'),
    E(16, 14, 4.6, 4.2, 'violet', 'h'), C(13, 15, 8, 17, 2.3, 1.1, 'violet', 'h'),
    C(17, 11, 22, 5, 1.2, 0.3, 'bone', 'h'), C(15, 11, 14, 6, 1, 0.3, 'bone', 'h'),
    R(19, 4, 5, 2, 0.9, 'wine', 'h', { nl: 1 }),
    EYE(13, 14, 'red'),
    PX([[9, 18], [10, 18], [11, 18], [12, 18]], OUT), PX([[10, 19]], 'ivory:3'),
    PX([[17, 39], [19, 39], [25, 39], [27, 39]], 'bone:2', 'l')
  ];
  D.noxseraph = () => [        // NOXSERAPH: fallen seraph (tattered black wings, cracked red halo)
    P([[20, 16], [39, 1], [37, 8], [39, 11], [35, 15], [38, 19], [33, 20], [36, 25], [26, 25]], 'shadow', 'w'),
    P([[20, 16], [1, 1], [3, 8], [1, 11], [5, 15], [2, 19], [7, 20], [4, 25], [14, 25]], 'shadow', 'w'),
    P([[20, 22], [35, 27], [30, 30], [22, 28]], 'violet', 'w'), P([[20, 22], [5, 27], [10, 30], [18, 28]], 'violet', 'w'),
    C(17, 30, 16, 39, 2.3, 1.8, 'steel', 'l'), C(23, 30, 24, 39, 2.3, 1.8, 'steel', 'l'),
    P([[14, 15], [26, 15], [27, 25], [23, 32], [17, 32], [13, 25]], 'steel'),
    P([[17, 17], [23, 17], [22, 25], [20, 27], [18, 25]], 'wine', 'b'),
    PX([[20, 20], [20, 21], [19, 21], [21, 21], [20, 22]], 'glowpulse:red', 'b'),
    C(9, 6, 11, 39, 0.8, 0.8, 'shadow', 'a'), P([[10, 0], [12.5, 7], [7.5, 7]], 'crimson', 'a'),
    C(14, 17, 10, 23, 1.8, 1.4, 'steel', 'a'),
    E(20, 11, 4.5, 4.5, 'shadow', 'h'), C(18, 8, 15, 3, 1, 0.3, 'bone', 'h'), C(22, 8, 25, 3, 1, 0.3, 'bone', 'h'),
    P([[16, 11], [24, 11], [23, 14], [17, 14]], 'wine', 'h'),
    PX([[17, 12], [18, 12], [22, 12], [23, 12]], 'red', 'h'),
    R(20, 3, 6.5, 2.4, 1, 'crimson', 'h', { nl: 1 }), PX([[15, 3], [16, 4]], OUT, 'h'),
    PX([[16, 39], [18, 39], [23, 39], [25, 39]], 'steel:0', 'l')
  ];
  D.dreadclaw = () => [        // DREADCLAW: scarred armoured apex raptor
    C(28, 26, 39, 19, 3.4, 0.6, 'wine', 't'), C(33, 22, 34, 18, 1, 0.2, 'bone', 't'), C(36, 21, 37, 17, 0.9, 0.2, 'bone', 't'),
    C(28, 28, 32, 33, 3.4, 2.4, 'wine', 'l'), C(32, 33, 29, 39, 2.4, 1.5, 'wine', 'l'),
    E(23, 24, 7.5, 8, 'wine', 'b', { a: 0.4 }),
    P([[19, 15], [30, 16], [33, 24], [27, 22], [21, 20]], 'steel', 'b'),
    C(23, 16, 24, 11, 1.2, 0.2, 'bone', 'b'), C(27, 17, 29, 12, 1.2, 0.2, 'bone', 'b'), C(31, 20, 34, 16, 1.1, 0.2, 'bone', 'b'),
    E(19, 27, 3.5, 5, 'bone', 'b'),
    PX([[18, 25], [19, 26], [20, 27], [20, 29], [19, 30]], 'crimson:2', 'b'),
    E(24, 30, 4.5, 4.5, 'wine', 'l'), C(24, 33, 21, 39, 2.2, 1.4, 'wine', 'l'),
    C(17, 23, 11, 27, 2, 1.4, 'wine', 'a'), C(11, 27, 6, 28, 1.1, 0.2, 'bone', 'a'), C(11, 27, 7, 31, 1.1, 0.2, 'bone', 'a'), C(11, 27, 9, 32, 1, 0.2, 'bone', 'a'),
    E(14, 14, 5.5, 4.5, 'wine', 'h'), C(11, 16, 3, 17.5, 3.2, 1.5, 'wine', 'h'),
    P([[9, 10], [18, 9], [20, 13], [12, 13]], 'steel', 'h'),
    C(17, 11, 27, 5, 2, 0.4, 'bone', 'h'),
    EYE(11, 13, 'amber'),
    PX([[13, 10], [13, 11], [12, 12], [14, 15], [15, 16]], 'crimson:3', 'h'),
    PX([[4, 19], [5, 19], [6, 19], [7, 19], [8, 19], [9, 19], [10, 19]], OUT), PX([[5, 20], [7, 20], [9, 20]], 'ivory:3'), PX([[3, 17]], OUT),
    PX([[19, 39], [21, 39], [23, 39], [28, 39], [30, 39]], 'bone:2', 'l')
  ];
  D.muck = () => [             // MUCKSPAWN: dripping sludge beast (day-2, poop neglect)
    E(22, 37.5, 14, 2.4, 'sludge', 'l'),
    C(26, 20, 29, 13, 1.1, 0.2, 'bone', 'b'), C(21, 19, 22, 12, 1, 0.2, 'bone', 'b'),
    E(23, 29, 10, 8.5, 'sludge'),
    E(29, 23, 5, 5, 'sludge', 'b'), E(17, 25, 5, 4.5, 'sludge', 'b'),
    E(25, 31, 4, 3, 'toxic', 'b', { nl: 1 }), E(31, 28, 2, 2, 'toxic', 'b', { nl: 1 }),
    C(19, 33, 19, 37, 1.2, 0.8, 'sludge', 'b'), C(28, 34, 28, 37.5, 1.1, 0.7, 'sludge', 'b'),
    C(14, 26, 8, 33, 2.4, 1.8, 'sludge', 'a'), C(8, 33, 5, 36, 0.9, 0.2, 'bone', 'a'), C(8, 33, 7, 37, 0.9, 0.2, 'bone', 'a'),
    E(14, 19, 5.5, 4.5, 'sludge', 'h'),
    P([[7, 21], [16, 21], [15, 25], [9, 24]], 'sludge', 'h'),
    PX([[8, 21], [10, 21], [12, 21], [14, 21], [9, 23], [11, 23], [13, 23]], 'ivory:3'),
    PX([[8, 22], [9, 22], [10, 22], [11, 22], [12, 22], [13, 22], [14, 22]], 'wine:0'),
    EYE(11, 18, 'green'),
    PX([[24, 26], [33, 25], [20, 30]], 'toxic:3', 'b'), PX([[6, 38], [37, 38]], 'sludge:1', 'l')
  ];
  D.sludgeking = () => [       // SLUDGE KING: crowned mountain of muck
    E(20, 37.5, 18, 2.4, 'sludge', 'l'),
    C(31, 24, 36, 33, 3, 2.4, 'sludge', 'a'), C(36, 33, 38, 37, 1, 0.3, 'bone', 'a'),
    E(21, 27, 13, 10.5, 'sludge'),
    E(26, 29, 4, 3, 'toxic', 'b', { nl: 1 }), E(14, 32, 3, 2, 'toxic', 'b', { nl: 1 }), E(30, 21, 2, 2, 'toxic', 'b', { nl: 1 }),
    C(12, 33, 12, 37, 1.3, 0.9, 'sludge', 'b'), C(29, 34, 29, 37.5, 1.2, 0.8, 'sludge', 'b'),
    E(21, 16, 8.5, 7, 'sludge', 'h'),
    P([[13, 11], [14, 3], [16.5, 7], [19, 1], [21, 6], [23, 1], [25.5, 7], [28, 3], [29, 11]], 'gold', 'h'),
    PX([[16, 9], [21, 8], [26, 9]], 'glowpulse:green', 'h'),
    P([[10, 20], [26, 21], [24, 28], [12, 27]], 'wine', 'h'),
    PX([[11, 21], [13, 21], [15, 21], [17, 21], [19, 21], [21, 21], [23, 21], [25, 21]], 'ivory:3'),
    PX([[13, 26], [15, 26], [17, 26], [19, 26], [21, 26], [23, 26]], 'ivory:2'),
    EYE(15, 15, 'green'), EYE(22, 14, 'green'),
    C(10, 24, 4, 33, 3, 2.4, 'sludge', 'a'), C(4, 33, 2, 37, 1, 0.3, 'bone', 'a'), C(5, 33, 5, 37.5, 0.9, 0.3, 'bone', 'a'),
    PX([[27, 25], [9, 30], [33, 28], [18, 33]], 'toxic:3', 'b')
  ];
  D.toxitan = () => [          // TOXITAN: toxic colossus of sludge and stone
    C(24, 30, 25, 39, 3.6, 3.2, 'rock', 'l'), C(16, 30, 15, 39, 3.6, 3.2, 'rock', 'l'),
    C(31, 16, 34, 27, 3.4, 3.8, 'sludge', 'a'), E(34, 30, 4.5, 4, 'rock', 'a'),
    P([[10, 13], [31, 12], [33, 24], [27, 33], [14, 33], [8, 23]], 'sludge'),
    P([[12, 14], [20, 13], [19, 21], [11, 20]], 'rock', 'b'), P([[23, 14], [30, 14], [31, 21], [24, 22]], 'rock', 'b'),
    P([[14, 25], [26, 25], [24, 31], [16, 31]], 'rock', 'b'),
    PX([[20, 21], [21, 21], [20, 22], [21, 22], [19, 22], [22, 21], [20, 23], [21, 20]], 'glowpulse:green', 'b'),
    PX([[21, 14], [21, 15], [22, 16], [15, 22], [16, 23], [27, 23], [28, 24], [20, 28]], 'green', 'b'),
    E(20, 9, 5.5, 4.5, 'rock', 'h'), C(17, 6, 15, 1, 1.3, 0.3, 'rock', 'h'), C(23, 6, 25, 1, 1.3, 0.3, 'rock', 'h'),
    PX([[16, 9], [17, 9], [18, 9], [22, 9], [23, 9], [24, 9]], 'green', 'h'), PX([[18, 12], [19, 12], [20, 12], [21, 12], [22, 12]], OUT, 'h'),
    C(31, 12, 34, 6, 1.4, 0.3, 'rock', 'a'),
    E(9, 15, 5, 4, 'rock', 'a'), C(9, 12, 6, 6, 1.4, 0.3, 'rock', 'a'),
    C(9, 17, 6, 27, 3.4, 3.8, 'sludge', 'a'), E(6, 30, 4.5, 4, 'rock', 'a'),
    C(8, 34, 8, 37.5, 0.9, 0.6, 'toxic', 'a'), PX([[5, 32], [7, 33], [9, 32]], 'rock:0', 'a')
  ];
  // props (no idle animation)
  D.rock = () => [E(10, 10, 9, 6, 'rock'), E(6, 12, 5, 4, 'rock'), PX([[8, 8], [12, 7], [13, 11]], 'rock:3', 'b')];
  D.rockS = () => [E(6, 7, 5, 3.5, 'rock')];
  D.tomb = () => [P([[13, 10], [27, 10], [27, 38], [13, 38]], 'stone'), E(20, 11, 7, 5, 'stone'),
                  C(17, 20, 23, 20, 0.7, 0.7, 'rock', 'b', { nl: 1 }), C(20, 16, 20, 29, 0.7, 0.7, 'rock', 'b', { nl: 1 }),
                  E(20, 38.5, 10, 1.5, 'moss', 'b')];
  D.meat = () => [C(8, 16, 14, 11, 1.2, 1.2, 'bone'), E(7, 17, 1.6, 1.6, 'bone'), E(14.5, 10, 1.6, 1.6, 'bone'),
                  E(11, 14, 4.6, 3.6, 'crimson', 'b', { a: -0.7 }), C(8, 16, 7.5, 16.5, 0.8, 0.8, 'bone', 'b', { nl: 1 })];
  D.berry = () => [E(9, 14, 3.4, 3.2, 'violet'), E(13, 14, 3.4, 3.2, 'violet'), E(11, 11, 3.2, 3, 'violet'), C(11, 8, 13, 5, 0.8, 0.5, 'moss')];
  D.potion = () => [E(10, 14, 5, 5, 'ice'), C(10, 9, 10, 6, 1.6, 1.6, 'ice'), C(10, 5, 10, 4, 1.8, 1.8, 'fur')];
  D.dung = () => [E(5, 6, 4, 2.2, 'dirt'), E(5, 4, 2.6, 1.8, 'dirt'), E(5.5, 2.4, 1.3, 1, 'dirt')];

  // ---------------------------------------------------------------- rasteriser
  const OFFS = [
    { b: [0, 0], h: [0, 0], a: [0, 0], t: [0, 0], w: [0, 0], l: [0, 0] },
    { b: [0, 1], h: [0, 1], a: [0, 1], t: [1, 0], w: [0, -1], l: [0, 0] }
  ];
  const L = (() => { const v = [-0.5, -0.72, 0.62], n = Math.hypot(...v); return v.map(c => c / n); })();

  function shift(p, dx, dy) {
    const q = Object.assign({}, p);
    if (p.t === 'e' || p.t === 'r') { q.x += dx; q.y += dy; }
    else if (p.t === 'c') { q.x1 += dx; q.x2 += dx; q.y1 += dy; q.y2 += dy; }
    else if (p.t === 'p') q.pts = p.pts.map(([x, y]) => [x + dx, y + dy]);
    return q;
  }
  /** Returns a normal [nx,ny,nz] if (x,y) is inside the part, else null. */
  function hit(p, x, y) {
    if (p.t === 'e' || p.t === 'r') {
      let dx = x - p.x, dy = y - p.y;
      if (p.a) { const c = Math.cos(-p.a), s = Math.sin(-p.a); [dx, dy] = [dx * c - dy * s, dx * s + dy * c]; }
      const u = dx / p.rx, v = dy / p.ry, r2 = u * u + v * v;
      if (r2 > 1) return null;
      if (p.t === 'r') { const iu = dx / (p.rx - p.th), iv = dy / (p.ry - p.th); if (iu * iu + iv * iv < 1) return null; return [u * 0.6, v * 0.6 - 0.3, 0.7]; }
      let nx = u, ny = v;
      if (p.a) { const c = Math.cos(p.a), s = Math.sin(p.a); [nx, ny] = [nx * c - ny * s, nx * s + ny * c]; }
      return [nx * 0.9, ny * 0.9, Math.sqrt(Math.max(0, 1 - r2)) + 0.25];
    }
    if (p.t === 'c') {
      const vx = p.x2 - p.x1, vy = p.y2 - p.y1, len2 = vx * vx + vy * vy || 1e-6;
      const t = Math.max(0, Math.min(1, ((x - p.x1) * vx + (y - p.y1) * vy) / len2));
      const cx = p.x1 + vx * t, cy = p.y1 + vy * t, r = p.r1 + (p.r2 - p.r1) * t;
      const dx = x - cx, dy = y - cy, d = Math.hypot(dx, dy);
      if (d > r) return null;
      const k = r > 0 ? d / r : 0, s = d > 0 ? 1 / d : 0;
      return [dx * s * k * 0.95, dy * s * k * 0.95, Math.sqrt(Math.max(0, 1 - k * k)) + 0.3];
    }
    // polygon (even-odd)
    let inside = false;
    const pts = p.pts;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [xi, yi] = pts[i], [xj, yj] = pts[j];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside ? 'poly' : null;
  }

  function colorOf(spec, glowPulse) {
    if (spec[0] === '#') return spec;
    if (spec.startsWith('glowpulse')) { const g = GLOW[spec.split(':')[1] || 'cyan']; return glowPulse ? g : mix(g, '#000000', 0.35); }
    if (GLOW[spec]) return GLOW[spec];
    const [m, i] = spec.split(':'); return RAMP[m][+i];
  }

  function rasterize(parts, frame, closed) {
    const N = 40, id = new Int16Array(N * N).fill(-1), tone = new Int8Array(N * N), feat = [];
    const off = OFFS[frame] || OFFS[0];
    const ps = [];
    parts.forEach(p0 => {
      const o = off[p0.g] || [0, 0];
      if (p0.f) { feat.push(Object.assign({}, p0, { dx: o[0], dy: o[1] })); return; }
      ps.push(shift(p0, o[0], o[1]));
    });
    const normals = new Array(N * N);
    ps.forEach((p, k) => {
      const mask = [];
      for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
        const n = hit(p, x + 0.5, y + 0.5);
        if (n) { mask.push(y * N + x); id[y * N + x] = k; normals[y * N + x] = n; }
      }
      // polygons: bevel normals from distance to the edge of this part
      if (p.t === 'p') {
        const inP = new Uint8Array(N * N); mask.forEach(i => (inP[i] = 1));
        const dist = new Uint8Array(N * N);
        mask.forEach(i => { dist[i] = 99; });
        for (let pass = 0; pass < 4; pass++) mask.forEach(i => {
          const x = i % N, y = (i / N) | 0; let m = 99;
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const nx = x + dx, ny = y + dy;
            const v = (nx < 0 || ny < 0 || nx >= N || ny >= N || !inP[ny * N + nx]) ? 0 : dist[ny * N + nx];
            m = Math.min(m, v + 1);
          }
          dist[i] = Math.min(dist[i], m);
        });
        mask.forEach(i => {
          const x = i % N, y = (i / N) | 0;
          const d = (xx, yy) => (xx < 0 || yy < 0 || xx >= N || yy >= N || !inP[yy * N + xx]) ? 0 : Math.min(3, dist[yy * N + xx]);
          const gx = d(x + 1, y) - d(x - 1, y), gy = d(x, y + 1) - d(x, y - 1);
          normals[i] = [-gx * 0.45, -gy * 0.45 + 0.08, 0.9];
        });
      }
    });
    // tones
    const W = N, px = [];
    for (let i = 0; i < N * N; i++) {
      const k = id[i]; if (k < 0) continue;
      const n = normals[i], len = Math.hypot(n[0], n[1], n[2]) || 1;
      const I = (n[0] * L[0] + n[1] * L[1] + n[2] * L[2]) / len;
      tone[i] = I < 0.05 ? 0 : I < 0.45 ? 1 : I < 0.82 ? 2 : 3;
    }
    const col = new Array(N * N).fill(null);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const i = y * N + x, k = id[i]; if (k < 0) continue;
      const p = ps[k], ramp = RAMP[p.m];
      let t = tone[i];
      // inner line where a part in front of this one begins
      let line = false;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= N || ny >= N) continue;
        const k2 = id[ny * N + nx];
        if (k2 > k && !ps[k2].nl && (ps[k2].m !== p.m || ps[k2].g !== p.g || true)) { line = true; break; }
      }
      col[i] = line ? mix(ramp[0], OUT, 0.35) : ramp[t];
    }
    // outer outline
    const outC = new Array(N * N).fill(null);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const i = y * N + x; if (id[i] >= 0) continue;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= N || ny >= N) continue;
        const k2 = id[ny * N + nx];
        if (k2 >= 0) { outC[i] = mix(RAMP[ps[k2].m][0], OUT, 0.7); break; }
      }
    }
    for (let i = 0; i < N * N; i++) if (outC[i]) col[i] = outC[i];
    // features
    const put = (x, y, c) => { if (x >= 0 && y >= 0 && x < N && y < N) col[y * N + x] = c; };
    feat.forEach(f => {
      const X = (v) => Math.round(v + f.dx), Y = (v) => Math.round(v + f.dy);
      if (f.f === 'eye') {
        const x = X(f.x), y = Y(f.y);
        if (closed) { put(x - 1, y, OUT); put(x, y, OUT); put(x + 1, y, OUT); put(x + 2, y - 1, OUT); return; }
        put(x - 1, y - 1, OUT); put(x, y - 1, OUT); put(x + 1, y - 1, OUT); put(x + 2, y - 2, OUT);
        put(x, y, f.c); put(x + 1, y, mix(f.c, '#ffffff', 0.45)); put(x - 1, y, OUT); put(x + 2, y, OUT);
      } else f.pts.forEach(([x, y]) => put(X(x), Y(y), colorOf(f.c, frame === 1)));
    });
    // crop to bounds
    let x0 = N, y0 = N, x1 = -1, y1 = -1;
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (col[y * N + x]) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { const c = col[y * N + x]; if (c) px.push(x - x0, y - y0, c); }
    return { px, ox: x0, oy: y0 };
  }

  // Monster frames share one crop box (so the idle animation doesn't jitter): crop relative to the union.
  const cache = {};
  function build(key) {
    if (cache[key]) return cache[key];
    if (!D[key]) return null;
    const parts = D[key]();
    const fr = [rasterize(parts, 0), rasterize(parts, 1), rasterize(parts, 0, true)];
    let x0 = 99, y0 = 99, x1 = -1, y1 = -1;
    fr.forEach(f => { for (let i = 0; i < f.px.length; i += 3) { const x = f.px[i] + f.ox, y = f.px[i + 1] + f.oy; x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); } });
    const frames = fr.map(f => { const px = f.px.slice(); for (let i = 0; i < px.length; i += 3) { px[i] += f.ox - x0; px[i + 1] += f.oy - y0; } return px; });
    return (cache[key] = { w: x1 - x0 + 1, h: y1 - y0 + 1, frames, px: frames[0] });
  }

  T.Monsters = {
    RAMP, GLOW, mix,
    has: (k) => !!D[k],
    /** frame: 0/1 idle, 2 = eyes closed (sleeping) */
    get(key, frame) { const b = build(key); return b ? { w: b.w, h: b.h, px: b.frames[frame | 0] || b.frames[0] } : null; },
    size(key) { const b = build(key); return b ? { w: b.w, h: b.h } : null; }
  };
})(window.Tama);
