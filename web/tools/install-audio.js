/* install-audio.js - land the audio feature on this machine in one go.

   Everything in the feature was written on the other side of a device bridge
   that has dropped seven times mid-transfer. Sending seventeen files across it
   one at a time is about a hundred and seventy round trips, and a transfer that
   fails at round trip ninety leaves a half-written test suite that still parses
   and quietly stops testing half of what it claims to.

   So the files travel inside this one, brotli'd and base64'd, and this unpacks
   them. Three properties, and the third is the point:

     one file to land instead of seventeen
     a quarter of the bytes, because prose-heavy JavaScript compresses well
     it either arrives whole or it does not arrive

   That last one is what a file-by-file retype could never offer. A truncated
   payload fails its checksum below and nothing at all is written.

   Four of the seventeen were already byte identical on this machine when this
   was built, so they ride as checksums rather than as bytes. They are still
   checked. If one of them changed in between, this says so and stops.

   Run it from anywhere inside the repo. It finds bcc/web by walking up from
   wherever you are, looking for the api/app.js and vercel.json that only that
   directory has.

     node tools/install-audio.js            say what would change, write nothing
     node tools/install-audio.js --write    write it

   If it says the payload did not arrive whole, the transfer was cut short.
   Nothing was written. Say so and it gets sent again.

   Then, in ~/Developer/bcc/web:

     node tools/wire-clips.js         dry run, expect 9 to change
     node tools/wire-clips.js --write
     node tools/wire-page.js          dry run, and two probes worth reading
     node tools/sweep.js              11 of 11 becomes 18 of 18

   Delete this file once the suites are green. It does not belong in the repo
   any longer than the transfer takes. */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const WRITE = process.argv.indexOf('--write') !== -1;

/* The md5 of the decoded manifest, written out here rather than inside it,
   because a payload cannot vouch for itself. If the download landed short this
   stops before touching a single file. */
const EXPECT = "ac23b75c6744585f47fcd68eb7f2ff93";
const COUNT = 17;
const CARRIED = 13;

const md5 = (b) => crypto.createHash('md5').update(b).digest('hex');
const short = (h) => h.slice(0, 8);

function die(why) {
  console.log('\n  ' + why + '\n');
  process.exit(1);
}

/* Find bcc/web without being told where it is.

   Both markers, not either: api/app.js alone would match a different project
   of this shape, and vercel.json alone matches half of them. Walking up from
   cwd rather than from __dirname is deliberate, because this file is meant to
   be run out of a downloads folder as easily as out of the repo. */
function findRoot() {
  let at = process.cwd();
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(at, 'api', 'app.js')) &&
        fs.existsSync(path.join(at, 'vercel.json'))) return at;
    const up = path.dirname(at);
    if (up === at) break;
    at = up;
  }
  return null;
}

const ROOT = findRoot();
if (!ROOT) {
  die('this does not look like the bcc/web directory, and neither does\n' +
    '  anything above it. Try again from there:\n\n' +
    '    cd ~/Developer/bcc/web\n' +
    '    node ' + process.argv[1]);
}
console.log('\n  repo   ' + ROOT);

let json = null;
try {
  json = zlib.brotliDecompressSync(
    Buffer.from(payload().replace(/\s+/g, ''), 'base64')).toString('utf8');
} catch (e) {
  die('the payload would not decompress, so this file did not arrive whole: ' +
    ((e && e.message) || 'no detail') + '\n' +
    '  Nothing was written. Say so and it gets sent again.');
}

const got = md5(json);
if (got !== EXPECT) {
  die('the payload decompressed but is not the one this script expects.\n' +
    '  expected md5 ' + short(EXPECT) + ', got ' + short(got) + '.\n' +
    '  Nothing was written. Say so and it gets sent again.');
}
console.log('  payload  ' + CARRIED + ' carried, ' + COUNT +
  ' checked, matching the tree it was built from\n');

const pack = JSON.parse(json);
const files = pack.files || {};
const want = pack.md5 || {};

/* One key in the manifest starts with ../ and it is not a mistake. Clip.swift
   belongs to the relay app, which is a sibling of web/ rather than a child of
   it, and a payload that quietly dropped the one Swift file into web/scanner/
   would have looked like it worked. Nothing is allowed further up than bcc/
   itself, which is what the guard below is for: a path out of this tree is a
   corrupt payload, not a layout. */
const FENCE = path.resolve(ROOT, '..');

let wrote = 0, same = 0, drifted = 0;

/* Some files are in the manifest but not in the payload, and that is on
   purpose. They were checked against this machine before the installer was
   built and already match, so carrying their bytes would be paying for a
   rewrite that changes nothing. They are still checked here, because the thing
   that makes that trade safe is noticing if the answer changed between then and
   now, and a check costs a hash. */
Object.keys(want).sort().forEach((rel) => {
  const abs = path.resolve(ROOT, rel);
  if (abs !== FENCE && abs.indexOf(FENCE + path.sep) !== 0) {
    die(rel + ' resolves outside ' + FENCE + '. Nothing further was written.');
  }
  const here = fs.existsSync(abs) ? md5(fs.readFileSync(abs)) : '';
  const carried = Object.prototype.hasOwnProperty.call(files, rel);

  if (here === want[rel]) { same++; console.log('  same     ' + rel); return; }

  if (!carried) {
    drifted++;
    console.log('  CHANGED  ' + rel + ' is ' + (here ? short(here) : 'missing') +
      ', expected ' + short(want[rel]));
    return;
  }

  wrote++;
  console.log('  ' + (WRITE ? 'wrote' : 'write') + '    ' + rel +
    (here ? ' (replacing ' + short(here) + ')' : ''));

  if (!WRITE) return;
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, files[rel]);
  const after = md5(fs.readFileSync(abs));
  if (after !== want[rel]) die(rel + ' does not match after writing. Stopping here.');
});

console.log('');
console.log('  ' + wrote + (WRITE ? ' written, ' : ' to write, ') + same +
  ' already right, ' + drifted + ' changed underneath me');

if (drifted) {
  console.log('\n  The changed ones are not in this installer, because they matched');
  console.log('  when it was built. Say so and I will send one that carries them.');
} else if (!WRITE && wrote) {
  console.log('  nothing was written. run it again with --write');
} else if (WRITE) {
  console.log('\n  every file now matches the tree it was built from. Next:');
  console.log('    node tools/test-playerui.js      and the other six suites');
  console.log('    node tools/wire-clips.js         dry run, expect 9 to change');
  console.log('  then delete this file.');
}
console.log('');
process.exit(drifted ? 1 : 0);

/* The payload is at the bottom of this file, one base64 line per source line,
   each behind a //# marker, and this reads it back out of the file's own text.

   Storing it as comments rather than as a string literal is the difference
   between a truncated download that stops with the message above and one that
   stops with a stack trace. A half-arrived string literal is unterminated, so
   node refuses to parse the file at all and says so in its own words, which are
   about tokens rather than about downloads. A half-arrived comment block is
   still a valid program: it parses, it runs, and the checksum a few lines up
   catches it and says the one useful thing.

   Both are safe. Only one is legible at eleven at night. */
function payload() {
  const src = fs.readFileSync(__filename, 'utf8').split('\n');
  const out = [];
  for (let i = 0; i < src.length; i++) {
    if (src[i].slice(0, 3) === '//#') out.push(src[i].slice(3).trim());
  }
  return out.join('');
}

//#X7E3MgrJmew1MzJQP1mvoiXU63FyWKgN5g65FYGcsBQLi53I5OQ900HzUFJJdL9Hrq6CdXTVVzCMy4Ya8atRNHfFy1RoxLpdj7++
//#GHIGuDNzpURetixfX7y7SQuzNhLgs8I67M0cJzlhD3HZ8iGIWmYmpej/yeu5CM6pbCiDurHCbK9U/eXxdxsb/wniFPQ0Oqv8b2/6
//#9fV7ejZgcoUm7h1n6WXZLdUrIq4txkRXJVDy6FhWNqte357XGvac69hqzjjDmRQClDdQpVBJTUyw7fepzaqd+9iW8hBj6Vjhav+J
//#t8pHGMJKkKHPX0xlR5Ac75ge/m8JyvxNEDXVK1vfV9WmFblSacslyqVMTqarncOnRVpCLAJ+ApXSfHOvIqqkw1FPdp/kJ/9FywrY
//#WrAb9nK0zVSvgafNE3KI/YNPbypJDP7fZq+IGqabWXdACvh+1ZzKT9/9J5rM08iBvqWwr9ptBUnR/K5MWPnkHM59c2qV0++jdDOh
//#KuC+se99ExkfJGeBAYrSbLM33WjFmYeH5APqrwy///++lvX90ZlkdY2Q0h7DKjVKe9+wZ/kd5+x99xAPD5gOAIHVgUDk/MyMzNUs
//#ZnOpbM3pe+59DwkgotiISLI+Ikn2MEmuXvV1sUZV9VhfCO2PYyvlClXf8qNqhJLmNzt2ahtBlH6/9odvUi+dX7fT6exdm9gYgxBC
//#CEng7Et89S/dlnTt2+vuVlvGtowQINAv2Zdy9T26Q8IkMMxfqFS5fB2yLEvOTsw/6jJ74/rhy9xWRPnS+flctCqPf7gzsRcbIL34
//#5JjyE28fxUngp7opkWxkLB/uc4KzENkQwE/nBHyzFKxBmdvECyDy7hhAhjFNeZb5Xb+oB3+RPqaU4gTdG1Q1VGkSFL7Q0tgGajFn
//#9jjyHwFT3lRwf9IsS2o/ZLLuYKWT9l5uH9JN/YfTfbWnaSdgONz8wUco4M2AQYUep477a0AjE8P8jpwz5hxPLmCz5M7HLO6hK9Kl
//#dRQzficMNCB07mCopgjYFNYA/aHRH2NpJ4gjZ4l/auskleeiu4wcm5xBP/W3ZNG99d6WnrGeN03a/vLUy534UJ+/1evPmaAJsLOK
//#/fdgiaqB047xtDBoH11r0PmKzhwt/qAX2WUwneGkzuTkc4lTUTXWGU5t6qnP2PMaPH01/jrgQVvlvL7SuVJeYpemSXTDjlL8Vl+s
//#k7NHZTO9nd7i2xvHzt1ws0Yc/jX+klm687AVo8QdonAeaYYFTDDAEAMhWqEGrHGB4ZVAvc5zYgA5kXX/K8urbH/Cg7zzYdqBWBsc
//#oNZUu8e8HGD1eubOKM7Mi40J1EgqZtw4DASm9ojceQaugSRjiK0TyAVqbpcZspe3/mooT4fqYZxpuxS9ipNfDtXnZVwpAR8ymWJw
//#VGhMW3k3hn95urrSodbBnEav2SQl8s3bBuPUZnSNV3GdFivIp9zVcxoumCJ7ziy4B3hoQMNOr6WDPUeme8i4hWrVESEa3c95GDgc
//#6yNW7XlntH+NlI0hBr9lllAPcxibP5mnvvzi37a+IlbylGKs7Mf8XNeMpnWAYCKfLL5MLLvVhs5iWP07NzjQ8UiPv11OtdDI1mrB
//#F/DhEPPgMeM1iL4BPh5VDMcCDyxpCWQWObPIyEZm8KhtEFpncvaXCIm23AYkXcSfqAZrSpFyOahcc6YAOUHieFwW99x5xDgXCbJE
//#m2n8RJQvr5s4Q7+MkG6uzMmLT1kgGeWtvQBgDV8dXtT/aUXGb/yb5yrfvf9vsrp/6EBgEgV7Y1Vkn0X27T3/6YPafQM10azIwSK8
//#wTV2LbAZQJzr27bz/JY5piV5enyOjyRUPLWlcps8xPPdbNtvBGjBE9x56/sjFoKmei1MDZQxpnYh8XFGg1ru2zagLhxD0ZLak37D
//#l7IkEBbo1aBUSW1GoTujlgGrQoESwR6RzgRxmYM2dikD+Wlk1KlUOqGZRJXRB2f7Lb+Uuib6JXrt1+uEwb9ffCh66bRfmPr97u5w
//#7m3+f/6J+DwTG7nLMiooPtqZwbUkGdg0NkoWrzi9bwKM5v+j4EaHQDKZoPvLT/QLCf/MroOX8FoW0GajdQ/IlaQslIbDdQ8ENUEf
//#gNfqnHdt7mBjYEgUcSlY7CqIa1vqDBeLMpxKy4fH2bSY/OJ0Hh7W5j4Tqs/ZhpfmYnsfH3prO+wesb5/LevP+7CM+I3ZawhvENlr
//#HmK/9LPZzxufn40HgyAcq63HkOoflP4ttrLBPVh6LPE6uSDGuP8c9D4+ZDG3xMrAxq0tKZ6woS/FKfsz8+S+MyKfzuv7ulEb8suO
//#+pjhJwHPT79wZfB5ZPkXLg6/qFF++TFfMWdszBT2e+rRtGUaeRDPTA8zRkctGTRs1tZjf+6piiURdvAqRfIE9wv/vtVclNdg3OfG
//#ZsJF2rYBwftVMN/l/4dnw4Yyj872bAd4iSRNsgNXw0gdEDnxGhUP/li/Au061t7buvPhedqJzKJy/i1vJQyH4CpjcSEY1NZkgMhs
//#XN/X4UteAUIpeNF4Ol9he/Dz5Q6TVAIv7wqB+cqg1qy8GXw7FSxEqG8U5YvnQpZs00rs3o6K9xSn1og/faM1cbv3CPbb3Mo5gRN3
//#UrocL+f9Gl1NNoGXy3xjvc0k0MW3Y/XiWCuZpfM2wbZDPJfiVWs5R8slFPsG8LwZhxSYO5QnLCdCfQWR3QQK2+llWYZXW0x10m89
//#4mTp920M7PjwIiPqfBAzCIgOP3AqmaUWxDk/Oxz8GOIqG4Ec0EvpErO5BJwo+QY2mMOmjMM0HO2g+R06OuZHIjYOzLFNXsZ8lVlL
//#IuvWfpI8J2c6dk3T6hRYTCBKCfOjTwgy1longC0qhbh12OiddlYlIUzXJK+fL2P972ZEneROKgUlTSGC4t6Fiiyzj5dylAlFLHul
//#GjkXrL55wVYEjyKEKNmfTGemeJY1bTOV+ImBnqmpZCJHtUsvMR/N3Qsw//RaSr2Rl/N9k1FP0bgVCcV+Q5MwfUKd18c/99IcdLz4
//#rY9tnWS05xkMZsNqKzpKrEN4wzpFQfRqCTCMIEBPa3zQt9b4maGV1PtLxU6UtZ6ROjmaKkvnB8oXpj6kSYsg9BuKAbl7vLZF/npk
//#3GzjUiDbAtx9oypfwX6giWOQlKNuXkl4VzWKWLnsKHzbTE0dIYemBuYagGhCzaAwwvy9OfVj0jd4nPoiIIN4WBObNKrZ2cg3rh5m
//#KUmhebJujeU4HFC4mON4wbTtWej6iqFTF3KpmjyNO0gHMzBCpd1E+xK25wVKqUv+b1nXTRVV6zlXfBaRIcblE8cIhQNlu5Bc0zrq
//#+GaW24ZzOuZulK/1EbbXjxXldEKsuPawG9+05G+bH+eWAc46HXDEwjZNv9ZGzjWBo3sUI4p4EBbuUOo/qaZ+6Xll18yHgHkJwb9O
//#AhNBi8JqCyzNH1kDaJo5DR506WMZHq0cX02WjBZLARThTJteSXUbi+OyUsnDGfJ0DnwPCM/49znXhO6FKeM1IYKZOxaosD+oowfZ
//#AXjCzJXzUFsfVPNLX0m5xhYgv2+ev7/Srezu6ue3U+PmYou24XKsq1I0PWzGsoROvxrblaF0VI2T/aAVcZa5sVNy1A3/MZ+5U1Jj
//#6sX4aCSpebGOCcILg0IwM1Esc/Iilvd39np7Zmg+2THhco/ExTQ/WN8YMfmawZovm4zJP0T5oPwYP64+ydIc6KqOj8NX/Piof+nq
//#WZ74VHv1OdL7uCk37NGoxeGi8h97LNKSW3Ms1bEvT5CTm3usqURwJuEyAdntHzV9P7AFNqVFQ7rLAk4aj0qyuAcEqsH33RUw0vY+
//#XaRmBKD2KuWxyWWNAJDGuyzmevUZB9VWtxBlfUu3PUKBVboyeBCzEH1BQ5GvPKSmx0eJ87XEyRh9O2zcYvM0SZ6v3J00wLvzM9a5
//#lJiCAlLCSUhfFTDETbMsMzL1NKcWD4ZZQ2N0plLXB00bWViXWRShzBXao1G/x0e3GyJS2VjGZgIoGDjvno0XZToPLhYjM0XKGg4m
//#OTymVp2x1c41wkX6x4s7cYdf0DZJP43pzNKRbEy3jNzULKS0pYTB9NaNP7Ovw042y8p8F/eRSXWHk43iNti8LeDnKM/LIq74pWKY
//#1nZ9azYgsxAzO0FgVc9K6VB86eYfj48tWY5UExsOksb4mYTJiAO4EKG29W8RVGzIm5dvoUI3AbrrChuUowna/rRy1sGGdh4ZEDzB
//#Fuzafq6SSGqWYx6R1FyrOHpnz5mhMiAH/X1fXNbgyFyxi8wmjYqD31QccSkIFwCSB+4CpI9fgprPCmKwGfxD06llam9Nx+02yemN
//#M/VVaGlyFO721vYGGhO/Yul/RR01JtuX6Pj1t88Gt3JZlTZ/kTtCvq20wfEDdMQbwrT7mcSEL3/z5YUqm+/3zhYwTKRPHKmdnd2k
//#YgpfwLIZRAxRMAvlbt+y1hvhV+gyEbk9leUg/rtNhZVC8nls+87u+QV4haiJv8pQeJTRMrFR+8iZDfJByEKDjg03RjkUdwZZMJhf
//#oI9Dc7SQ0R1IvbjGzZ9o+UKAJkdlg55eNw5BxloJc+Zj+Ny5i3t7BTQeVvgZEqJ3tvoNqBDDAPto1SZDLNqt7MyV/oroi1iyJZkV
//#2jZ04jWt/R8+eS+BVoLByC7dsHx4+YhdA7ubI/TtzyTzn9k1Riz1KYzI7O6m5dfKQXNFMixweqHwP5FkQifiA5H1q6v6F4f/6IM7
//#H+KjcHGucf9g6YAfy9D9i0upXRi5f3NNEDU3nxYwzGPyOt37kWdpG+7GEKRtI/dvrhHarLnvuPZNr6a/HZPMxk/a0UPVvH5VXjux
//#RgAZ1syoECZBYH3EiDoyYCVna2mbWXQISUNLVs9gbDUFF6eWVXuV1s+2WPvdG/uHdkUwTdpZt99xub6czASDKoh7nC2NYPJiJk65
//#fYB7YNHuJZEntJcLS4A/wbkGIFDCNkYqCZTnyoh0347K+4IVuPShZKWSVZLOQQV+Mseh5d8OcyZXpJpN95wermucX8680t9cmfir
//#Qb3R56jHiN3Pyt/Bm7V5Ir6bdkAu+O7OliIfu9cYmrpzaGDSEQMg6mahC/GxBkWwm7UXndGnQhsTysMAmQbV+KG6JI3VrYEGk2aw
//#zy5W/mb9ydanQXUMvyc3fN4SNz8fGejK/Mv/cW+VsHe3wQJnmOL+xM8oVnhGFxy0JJAel9YyRwCJf2WiSWRdIzZnHnZ87n2Qs9iU
//#nW1OLsSDEQ3lBVp2xRbs+cZNlyYwVUA2rJHimN/dXzuPzUOMpT9v92CKJpg/oyJHcp6Gcu0wORI8p50HUIdPfEzeRQpYgsYUbNOO
//#tGnKNbgYm8Hesn8/55tNjU2qxoGOOpZ5wtF+2URcL2WHxqzM3CJmil7caPOM3hlT3/haAh+ZgB6hPhL3IpOMgdOl3MMJWhj57LKM
//#4DvCiRxqEoCL64csV9leZhNXl1p0E+Z2Y9RJRZNsk+i7GBuPys5Wa6KUK/pShgeDXUrQM0KpJU+Hwv7VZxDKzbUvPh/mO2CpsVjv
//#FgcRQsrCVB+qwroIHudsMUk5D1Y6A6Kz0o6q2/g6fQS2ISoPClH3BfaBobB5zX2ZrnOIkSyP+9PotAmXMkkV/jB1lG5PDbnb2N3S
//#H9rzJ6chVxFtqMIx87VyS2Aci8xhqAYgUITKbkVd1w+oe9Ey3ja5lxOyBvtPBzFD+Gczov/hXta9IRj7RJenfDuWb/yfk8lfAqV9
//#tJgGCTVOpTM6cNbcR/P9wo8pT7hHBEMmioQHz8OqLbIusU8Z8RuUyizjq2dq+IUZz42bv88CbZ6QwjpNL4sQlp+W9qGkYS7TY+ev
//#nkV3X7GBwKH3gBf28T9J4sNj0nDI3to+1ZXFj39L+NQscuAk50mkLGW+HrujsVaRxb/PCxLm6CAOcQgF6DXNmry6MRzYVEVeT9tY
//#VOo3ZvmFD2lPm9C2vjTijEylPcGu5jiRIBTkJsWcz0xBHtGiKlxH2ln6slQ5/76Eta7xekWjRxILWulunI1FPijL7OCynM6BLk/I
//#sIX5Dpgv4tNfteXz+7adDEjkulkpY2PsDJgd1Hhl9UrFF8er++NBaROsfwwcDiH5wulPbS+YFKW6HzTSLHcbOnSyOfQDqWzi8Q7u
//#5EDvL+GQGinAGpobHjL1fdj3826wgt5NpSLsO3n5996t5O54Q6nJ2lbnmGagA4b4OPGPaDeGzMIBDVXFriX5Ht1Zd5Jj9rqexoYm
//#QaZFYdqvoVIiNI0Y389GHphZF8wqjTvn+Qg6renl4+ZyNu8XtgYhWwkffpRXecN8BwPlF/UrTV0m+uZSm7xp3HuIbkej0+wI42Pb
//#vu7ZloA+bAUl3PB7ejEf7rdzc7/8xzld5nveO7CMP0PSscGNSkeYliiEu8z8cbiNXnZ9XsF0Ggr7k+XPhEPPJ+rQG+gH/EE2WRVg
//#9+OKm727/d6vReDhzsile08WjVfvEsrCx4tXV9PMOQBdQ+mD9QutX877Gh3TsOw295fnm7y+uP3Oe7562tn8/c1rzr2Ymr1fB2Am
//#R6TZxQG1fSq/ShmGAwmrkvEZyjjY1ep9MlKvsmKi4VwfNjmrQoM83xt6TlmqLdn3Lcp2nHeuUTNgWmVQmPzhBlI4cj2xhbzseDg0
//#fBurXjvfrJhp3LHzwYJlcj644dt404rqTSpcb0jSacrdYsXUE23F+GFIQmG4kJcxX3BSUjGnF1sEKSoTxYriFMorRplagdGaWf+X
//#HFdFFFMNd1736G5gy7DN3KvSPUCEL0iRlRK/d7lRmPUOF8uTLJt5K0B6FrCCRr7pl2iNmwG1iXXvI8zpAeqcPm3TEnCbosiOPjOO
//#G7MNY2b+3swrJDjd0F7Q+RmyjplEZaHEXYQDkeMh0gHD8ryAXaZxkbsE6zTLWK8XXOAaNE3ghAYeKJJE7DtxfDYumaNFq3scuhXq
//#hfUvFFciOzkkquTqSrdS4JsOxCu6LBRDv4N4XrKxv1pPC2c03WmTClGKdJsLy0JEtLSS7f/esAWfjaLRjWFv+S0BsjBmhM9ZYmue
//#uZkmrkQoFnZvcprwKYKSV3q53l9zXfvxx60AatM1nMmc3HKmrV4J9XNNB1A732ir9cOM4BicQdWjFtdZYU3TLR7WIcKLSWMRlX4l
//#N11c12D/GLYv0O0H8ANGZyZpuDvjxUtwUida4YKAU9ekQiDY2nbvvyzTr1gq8TWfRSPuPfgMoT4OfmThtUR9MqW0B4Y/4Cs83Oiy
//#YOcbsPizvwgM9z9t+hdOgtv/Q23d8l0N1pIUMpItnFOUKS1HKysoZoqsQNRUJn4AVjNjyw+qXtr+3z5tkaBJ1mtv0b/YhURm/JC1
//#Jy44aWk2cJ/t7tZX5bdAk6u4t1IoEQNx/ReTUOQgv543W5yRwjrloSUc4IoC6+XbpCsHCDgtQqsTSV/L82fYUiSezAuTCFxeBdde
//#y77tuYqhQ5iJhhH4xJqdfS6TeJH8j3WAS67sDPLnGosEt6sgMF5WVxnoTewer3ysGZZp+xub0EUp90mxgLxohBgvXeQM7cogzVxm
//#d4i1N8nxjUcqwh89CZCnsqeYMt6ETRKfC6kkN29PFcf7JKrsPmDGOVWLxWB9OasH1VIJEzo5vM8Jzgdty7cA64VM2ObrjTnWsVBF
//#1IQJluRONrNxTsd5RUhhBYf08MjLGUxMquKi6BSaKpwGn23BwKqaB8XuH7HylE5WA7g2gRJDp6YU+t7qbeOgLwOAklWcdMase4+U
//#ONrHGaixMGCQ17z9BUnDT8rwn0EKNZaU9dITRf0ai48Sx5R78tW31fHFj5A6IgorSjLb+ODInffLr2SUOh44RvfgnaNXMzXa8WBA
//#kEu028Ho8eqWMTIsG83p7uUeAoWexrv2YZmTpulkPSnfOlRLMlAZbZJb8yuponEz3Q7shSyrZxIgMbQSpahRKiIZKdMz+FSkbF8G
//#5ACG6cs2P7FRcMJOxeChhp1npVnV6dhOr46R9nAySLglqM7YHDTBaq6FB5Fd75ytIHvjTrrejZLq+KEt7l6O1RRcfc8gxMmtmrD+
//#9/4u+TaqdH1WSLx75UCeUsLnAdXoilBUEFiuw1M+VqlKOa19ZNMoqXJQdqQaB3AtxHv4gpgkiDdSPu4p8SJKJab3EnlxV2GcbZ0t
//#jrnvcVmm9zxVeUQxblecnVtu6r9AF2u+rTFMTNk8eEcLcCPhqzMvoxCmTfChwDmekETQT++F0PCzXiCxiEh0vXXWxvugmj2AGK9d
//#8oR9B9qrs9mLmTjvJJeBrTj0Q4fcnf281bEV66k5OO5bEUg7H7dPK/jD5T0SZW2ApStcYtQ3yDl/H/r5upJy1n8fSBWjJU4BTFXu
//#4HR1Xymgf7Fe1tnzTb0JXFX28P3+59SQn1jKgRfm9pExnN1S3voGTpmAv4C3wzesysC8+5w4sWiZ4cVYHlq7OcuoWro7t4QQdv9y
//#ZajjRhmiFJBiL2PFXU2uwtPgCfVx55V3GagW88asP96XdcOBDeqrrXrYkGfU0orTWjOwmijqIrG108R65r/1SFR9LkJG+RkhCl9Y
//#rGPD51au/PFKw7tSMh4DQ7XbRmk9Q0oFT4GmrKR5qjvAAnL8hX2JeRqnCxOeFo3Xo+bcODkgdNgwwMCMOBSjslE3cr9XdjBadJCY
//#qjWac4qqiRX8i7Itl98S0oyiLtk5WzSvyudjjzRL1un8yyd2ka+imIdYyXqJ7PmAEWqOpxZVUI+XB/jYKJhFZF6GXNQMyUZimujY
//#YjOBOW/uUaa4uUmRXtGHCOlyzSswXB0PZ9W/YovYV9PMkt6LtpzpJOW7uaElY6/NwDgXRuZH4vLT4IhR3WHjlaALnXYqlDXUS4cI
//#ettQiopmdOll0aPhjLLGOmyTqT27Uxphhs6RfzEvA/ubMMZ4yIvhR6x3damyjiS58g4i+a0IiLwPCUEN37LwS10h9uy1g3hdz1/C
//#TQcMebMSmbxu2g/DorcJc3GHOpGsU497RWx7a8XpvcsXn2/xJ1mY7fG0+lNNvkJqBqwU43HbbHsYMkzhrlE3oyP7N8nO6e7i19rm
//#0fbMB+6X26FEU9KKRxoYSFWpXT5l84idYt+9vFKoSyHfqWN9lbwX78cHe165Xda+KPRv1phz1QdaPekL1qtDOrfYLwaSIJwk7wtD
//#FcabR0Zn2TtECiUoxBBb7l+g7Ixce2iZp0FJvLDZROvoemAp9JiIdVC6QkpJRtiKR9SYXPyIG2D3dPQoKxizgq0JankuZkp8rP83
//#63Y3PYyxIZnyYaMpxu6GRhjaVPcKQ9fDJSKAyF8tJK2RRhqOChaeI1kj4Ar6Z4Bogy4aaIMfI0wx0yKBgJlhjVHqbGLkqC2PUeCt
//#iALMjsWRxOr2Ah0BKUVi7sChNvv3v+fKXqt355MUy6i37lviGAWWcE1CUyEl+AgSpEXR0TK9UJJVrQ+W0aGH7m8junchxf1ao4LY
//#uBvvM64boV6OuHjk/s5HCIYj94M/1HiMjEKWw7SBWIoJKwg9fEcMfwHifme/pt9NlHLm6Jf/vaQS/9dPPj/IAi/JpELcTvEP8b8e
//#E4sgX8MsCkzHv4jlctXkgtNBaRjGbGTvr9wAm5WU09A9xec1K5yYJa9bA5MF9e7GMqW8P4rXWZEqvD1MTmLkSlQnMJkKNrpBYqrP
//#sPNf1bntvP50zjRFj8OKp2vYnsFyCOxjnIsb3hg82NTC2vMgVh/CABavfMT+hc1GqVyG40zw3Kr5uIHr+P9WIeTvovKDSWZMl6A8
//#UxJJ9JaN1Y+1sGNMGDw+UMPI+h6FrVNinWFMGRHkQTbR1CvWpjCTbL0fmlXHG1pHKOYniMOkCM82SepoVI49oL3Jly7L4hqPG5JX
//#iq6pEiSzViq9QgKjXBUW4ni6NbW1DgKdi5fbzkepNqOgop0xsCPIc09z8bUDDa9ormjU599F69jT6gB9nxaMa/te73zvdrXjKAfU
//#Jo9RTm8E3xwRv/ztc34hyBvu/V/dONgYJQ6OC884Q03gbQquDr4KpgdJ0yFuJJGgyfj8DqGJAkcjo8TJi4kZAqW2r6kWxtjvzhz1
//#41MaHSLkoC4X1S+BcGDLXh4eZjAjldkBr6T5ktqXSS+JS0JI9eiST4Xid6NfNptVFVJBAxnc74sW1TPmRAOyD5dgdYCJuZrtDl6Z
//#zO+OSa+pF3HhYJCWdCwzCxzT0NiBVCWOtfUrGPJz8NUySWgSryo06ps5NEwpRRkesmvM9yCDxt5LAMPUjjuZAWkoAwXC4Sdaakhp
//#nH7ESM5quSkVkNNDk87UkMxwgOXLH5410lQlDRj5eQZuI37+BNsejm2vOv9EAEjE4pbSJ5Z9E4sWbkFNPcXtXH/DZLC1SzhBgFHz
//#JXAxMoMJuUKyTsdRd4rbD7LJ8kDth4cqIpFKOpzIV+JnLgy1BFeuN8+cY78PG8xpRtqejrc1ZJIuHrFioLNg4GNyMOUsUliuoVY5
//#hEUzJxpNx/o1aBcxB0JtUR8MrwF8MBq4mAiLh/NqsgL4xFQECc+2Ai6NZJS+m19mIB2I6RSGH+9X+1OqVvyeVClEcuJ6LKl4Rkm3
//#ZPJM4P09Z4ifJhdS+sQy/26KeodKpjCEYWQPbq8hcPxkCxQXjqAcBo9m0ZTCsyaovyLCR7X3XGWPe6oJLjf04w1Sx86gLTmfNLTL
//#QZUqm8jdhBkHT18N33Q6ArqlKOuHzmt2IPMyXzpvTb0uYcii7ZexIwODyvRlvTsWlEirWE1IgKQuRgFCZRcKTBMNo4nAa7kaVV6I
//#omL5Ecx1F0U3gYc/CndBI8wTPmmyc687rCLFtidzF52y7esHTzJpmk1AMH9RThQNqFokZG/r5wwoRV+F1pdw2EtFfgI5ToTPCTDZ
//#Rp+D+aUMgxIOx+1d7z6udkqD+J8odC59C5FhXHEG83MQLh9jVBfdif0SWyx8YaP1SyHLtAybGThULqBJ3d2Q3S31p+bWUcUlAlR7
//#f1owB1rHKsQLbNtjoyFGXzJL7MN5PHgM72RS+2T5n1KLxnoyLrc+wGwAmmgIifi10BkAE4Q0geqJ40Vo0QnUEvb7hhLK4t8BHxjf
//#5Imsxjn/rvw7ZoSL5xxjQrRFCHxjIxi8dJhDyrqrTAKS3Nmc8LdOaXuzw6EfS0bx0PUUyAnnOM85x9ntkcHO07FqAKHnPxEJP89k
//#Mr8B8IfXuhjr/mzgveGeweEQlCVmCxV2+PU1mjD/CkXKf+Hwnd7PyJOw7yCsWVeEio1xN+aHqN1RsJSQ7jBbZ/kWsgCpiKa/TYWc
//#UY6P3fmEhYgTY24ZGg/zMWLQvVMR88U1ewCQWz2oYRH8wB6AK+z/DYuQYkdkZDS7qnVJBqUx9NIZZVxlIRCj6SkulhqCRfWZmKSw
//#z1lNW6u2pnXkpR0FSfMvgXjf2eP7hp/6FVS38dCV4V6xBy/AJjMb+gfzhg4bNzOjiZXL6aklhXDz+mon8LDq108tyov3ZXDaSuMq
//#H1mK4JbmM8VovsYcZIBe6iNSZJBnY/KjBlIWCbTCdiHEsHk9z3mw+m2Xn06rNxDbOWO27FM9QwT8eAaeVAS2L+LLT1g0sWE+2ljI
//#IsExdlK54bwlch6JQwuo8wFESGiUYIgj2zKTDpTqEWiI5RMk2ZJqiqPZFARIsTffeWa7fY0jj3hpA2lczps4meJ3eXCtmsOP4ob1
//#IsE/75JnRbzwNkjxp5VXNtyZD5yEm6/hHBo0vnzy57lFf47nIq82SrrlBDmCkt5lPI8nzEsGldhIlawpODHce/ZhmDYeakyLiARY
//#IYxZ9q8MZRbbsB4C7b3Gd4E1zpfPR5rWTUINVDk1GB5smoLuvIKUxDoNdYhQPp/bVpo9doFG+/Yyxh8juTAlT/JwaJ/pEPCkzIsE
//#z/kgcDy0hxBTDtDvbFXEQo8FSpxruOFjWsAb9FOZZSwGHe0m01abrGbdc2aGnxCePmLOP0uVOUBeC2aKgQKDcbcsjhaFXCllaxgB
//#vuoZKcdyWZ6O+0wYv0NtkwCI6/dp/LQ6RM2niZEIWcsmEWwZ2SC+c6pgFA1Vmt4HSQHzPhZcRL7l/UttMU5FZW3DqEfcrJinD60w
//#KdsQStgFjDsFas8WokDmSuDPlNNuZk0LtCY9n4PLpdm0FS/mhOFoMsK8dIoLms1LhsvuaWZgErPw9as9lk9HxUR4iiJOXaFcW5nn
//#A0YrIylXHk86riLXQ+s2+0t6D2jddGkyuahCxykN7nYs5ctXA1VHvb66aqpf6+fIimj3UFHPF46HExMl1/vAyPsZ7kZF9anLVuav
//#ZeQnmAQI/RUwBAaazkjKltzKR8SISYn9Yu182x+Do8On8CwW82eEZWDhfKp3o5nX63gz0eWe6YZq0+NVV8VUKJGvqKlFhfwYQb6r
//#ZVRouE/bVvONzODa2+7ZUZOPGCSrfPYL86ECdWls8uLFZNpIlkuoom8DkwUi23iewGu9Y7B1p0ZnlhQQu5YwKrWnJatxy6GQV0JY
//#47sNJIc5uxD3r2kj2CvaV6p1k1QttKwATBWHDK3YQ4UHEbNzOFQypqhT2xm+ys4GKQJu464sbZRHc2rsJ2sjb9xRTlfp9U3uYc2r
//#e3Wpz1Xmi8aahhYHrzG2YzJgMJh/n7sjayK5cPokVXX+cMSzDaYbulJfPG6O5Xin8Fr4Bgb01q6diJ05WdEBhihpgLFHVnYYWgE5
//#niTERy5pz8L9Vi51HlrgZxIPv/Wj0dDbUYF5kBqVs7rTLpwvTrQhAgdts57rGCy7VhWCwAePJxZRfomR7RTnGGMkx7nlXTPFidHM
//#jJqIa7a4jqjOGi0EXMMfsZTnSUkPtTFPDknRh63aDLF6zPAwUlUm7PPBaL7JtdKgeL3BErhUoIMkfOIF71HGB4nVD3fnG96aIfsV
//#qOkTmUiNaNthnkDAfGfKNRpABhSvB6bEh964P9Qc9Jxwx+XoK8hs0evUaMmXhoJoZf6kbeDqjG4U1SHG7Q5MD9jSGEbBy3Q0V+OW
//#9rrY11WmKH+zxT2FWmGDEEvVul4+QSzOQ/F0C3Te0absHJAvTDNU/sMoYT/yLToDv7YXwhJjJYetxvVJd4zGCaPB+1NC3FUFSIeO
//#RaFjIVTDD/ecrJOCPdiX9Ls+26lG8nNjVtaeaGHLaKyEf5LWahxJ6q5zbIMH/V/80z7+bPJPcvIKIih/uDfhmWdBFB1qipc0gngx
//#Pfnzp90r44NFkrxH4ntlCGQhyQT1xbbR8WUsaDLocV/2Enare4BuMZsCCUbn/w/+uLVIm3E++20fpKKNqJQ/E8xgb+yPjVEq7svF
//#xisCMr6IX/7iazU3RfkWP1tKmgMpBWbGKdgkJRARZL9Mm7+ZCmtQS++3zmIH2rS96QAcmoZMQfeU3Nh9QsU/FTuw0qsdiFOIyRAR
//#IJL7EYdgkwl0ZKD7E52NR3vUzAXUBAqErpqXyAMoC8uVaDMVh1N3dit0lCu+mMCMZHaSTEsy/WFSOT2mB+RI112fJSTzDLNLIJ/N
//#brHJlnYQgGKylLX5nu5ldYjsEs/TVrv4A8Sy95zLYFRes22Nx8GtYaW/pTFjfHK7RhxeIL/S2Q4zWRVs1yOt8waNW1VGzxsMOV/j
//#GVraKUsRta57xIPWQVL+TJ6gwbbiYj40iMTGFApWZn8b7Oei7xEeps1hmb5+GE8xl3ithnPWiSjxjcztANqenndmoJr+dudpi4dZ
//#vHgiN1gCwuHiRv6OXTJf1s56kNgdJh3tn3q0tau+mVsq58LY8XI0wAgN7c2Mhn6WD4uBUf1rWfGzQhQ3st9cBwwdOlIVv9zF9t/H
//#/qE19PNbvuq7AVUkVZlwA2kBqoNkSnR31QzNQdPmyClAIiEgrn1OHszSzcPunGFvjGnwth1nsIBrKUt+DcM06g+54tPe0hPzDq4k
//#+Vzvs0nsEXwlVoEgGYSBWwF0LSZI8pVZczQvt858f674G9eVDFCSY0YchvGZLe8CNLpQic3gaJJkAGDjOBvJbiqybN5nvmUKFXwt
//#q0e1nSf4D4qamBQu9oUskw8vS7HUPLrp/Y08orerFkiQTni4MxFrlUnAg5Jdg7FYTtwadazMlWyVAdpk9ZO9P9vdY+P7stYscodH
//#ghEl+tnEnjLBoz194tdkGOX0IIytSsxHYmC7FNIofLnI5iwirybd9xtf7c9sczGvmAoIWFv8DS6Dl/UmJwZz5IgSUO25QiLqXGq9
//#V5b7Zi+WRaUI7Yn1Z/XtvfqzbtvjEHmK9dUfJ9V6KjanKLmHIkf7coAP0VRPxqueE64GmT6OO8wzSY3EHHalygU/1pMK0RRgv4qd
//#uOiDiGXMSvy9F0K8zBVZ+riEJ0vNsL1DVF2w7a7sMTW9C8va8u0g3eft9cLX20A7uYzAv2ZWJyWrp8V+qKkSk9mO6zTzevUO9T92
//#mYNdP5wABUTaAszSZAXA9/yMvWuni+euBn/8tGs9v140YdpUxpCh0y7Su61HFpEqwSU1nin0he408hHvqtWyi2CsACYjumYUT5t6
//#fGaWNv1Zxs+NIDqMk5xGUk8CqWRuyuIRoZHmZMzD9oLFH6taGGZWeQX1ZcIvcrIoOQj2qIHnY3dWwfkpWM1ivw3PTDZ1yIuImViu
//#LSYNzy4husnet11q4hAuJJ/87ygxb3xZOVHTJEnkAscri0Lt3xAdzxCNaJVBvifJyl5cIIegiTZp3Tp7VaBS3sxoTnnMKMnxXwvQ
//#Zvpi77ErI0obfKDM5eqH1Z0lTh1qQM0vM3WDUFexCAxaQbTp45sPDilNicRyccEORsfOrO0/ZqOTZ995j3Z3KqbklY28C+k5Ndj0
//#ZUp/qSpQ1F2ZZPrRIv8gsLTpzok7x5zYkJlTFEGbMpu7sSakE4Rfr20ggGePPOWrrFUziXFnf291q3jlQ2VW0hqQ3YLIoR6EzCqw
//#cWUBOTQ25cRAjhB578r5WQE0+Zshe3T4bzzKkUS84YU3jFxMN77oVpGKKHOpyvYu9F198BeGl6RDid0eadRNEPyhETGOdVq0sy+m
//#7EgihUjuk7FnwDZysTYyAVUhGHp1JpEibMrnuAlndhBmcOUr1Q/DKEgoVKymMVy19Wxw0oDDsvGXgUEr9qvreAIStDeeJmeez3KC
//#RGE0fLo4MnDAjuc4YurjJ40zIraAz/teKJ8b63OaeHglhGktKvJB3ArH+7Fc24o3C7laYP9aelk1dDSclOMJtpwP7d3fJr8x3yoL
//#jne/rzGHfMZVdhQecQ3CNCWglorvzRG7+n7GWsEvAOMtRn/b6achsjTFS8T2tGTQAcTKF3GpkX0PlY95EKLzGv/+n+fyvAwOdqOw
//#QTBVgW7lD5oG/bZWpkX64P+6D5PppGZCAB/ky6DbJj5qo+Eb2xLjT2qvBztFLaQGwQgx8ii9fED6hyOfJKxjvDleyo0TJzEKL22O
//#KlNUY42xx0qeeT1bk0cu/ESrlgTH4F2IVWVHVsy49OTT5sEaOCpgHD7agecAyb1r9rZq7ZPAaHWz9resDxoFbpC/rCSwJ3U7uEKQ
//#tjVO714G+MfOOJQIWLCVoj7HXXVGlcNTSGaOPIP3zWsQ0aK5ROwTy4cdiiGbMkUYyK5oHSXRNDbHpUxrHXPP17zB/EBmtFRUSo7c
//#KGrBIRNNPmLQnQdMJ0Ex/y4ONicfn/6giZFi/JJ2x6gQuUghIMtxcu5UNwwQDSs+s59p06J1n9WswIw3TGeTC4MMQQPlGh0MDqZc
//#0VB2wtdxtENq88MVIwLq+TD/aHDvKtQQqlTMvuJjY6NThj8YKTnSBvzXtZWPf26AChuBvgR1RMmpkc0nd7sQdTy/CoQLsG3lsEfc
//#9/kYfvaOVhYfMyZSEi0G8AJB7SJyMv0eyEt1fBXj5ao/ZjKZsr5lFwcz+zR2JNnMB5rIT0vMChoPz2XG4Y6Xkecmj55mTLWgAEAt
//#zUzRwRbh9UVAH8/mIVNQWEM0X1L64IrSqoHUDtdHD2NLxkg9ZZk3I0wJ70MtIpnmGrmEXJBuHyhFOnQxLlM19OxgImH2HWNdS0T7
//#yk4RJ+CP5Z/xaLQ3WTom99tibyF36gfDg/lnckeMZ9DxxCKwpBWhkBisaVpW8PKpy/yS+vTTGVY+LlDBzBcGqBXdj90ZIk96kwey
//#exfI+gLlQqnRF1Q9/S4fGkRMY+/cugpCn7PTkf5sW2FMt6wrKf8Cd3RfBkEpktpPzK+LlnkVUEerzIisRFIBGDmI75qW5scNnPKs
//#VLV0L9vaPkdncuOP4E3eJuuxBIzxp9RyKyBBIIAMu9cAng/ycyJvWuLgBsWxIFijqlP5YwQp6JEF5q1hheHn4IvfGuR/oLgLzstO
//#x/wrod8r23+H8HAO0rZkWreWFVMqNajA4LohCFgnXSl81BUeEbK6odDg84yz6CTDyvZUR7Sm/nk3DlDMcr+7dpvSM38Cea/sS36x
//#bMkd4SyMjd8RoqTvmWmsXDJZebe51XK2WMGWKfT19cm6TqRBMl92MXBOonlFPu+B7cR/xylFDUSQilvEPiEL7ixIxDZLfIZQyYD/
//#nG30pQcJv/JN8JWHDEMLOzmH959TS+r2ZZ9IdI/kfFBJ3wMkcpI+FetLqjNvh9+rNLspYsm4sBsXUOQRewSHK02aVhGX5XeCEFy8
//#SARwfzqnpRa2epy+UH/BG7v6IzQFDZbQnOvBSvcn7n6WMytmkmbxAEDl+2rLQa/AE0lFT72OKSNcuMLsEOopa/1l+uYqhizadH1d
//#Ba3mMe3AWQ90QDf69cVlGU89WvdgJd06cdygVS0+StcUV1PX1NNSMr6vm5QoiNtMoQ0u0QIodgjtdbXgzzLpffTcyvLme9jmX9uR
//#R5E6GyaXEuSbJTOqWzqfu0/koTqZLOXcslu/A4ifuyDvpIEIjjsjo0dfDIXU4/JFauQvkqRfEF/oQIPrhyy5CAH9EFKs4SOcEfvp
//#p5Ek6dkWiCXiP9GsTwq0ujchzvffw0p3mtEii59cIY+tCLqLrgRwk5I/y2HcledOQIcTFkZgpu4TlB4EVD5/jvqXlk1yP3EfKBJN
//#5mrDsmtVOAIVvfuPm+bVZ2dm1qrrMfMM9Ibh3f4h1As1MnhUczDagzrmCfMeZCZGDcXcff3V8BHEIoRgDFxI+Ipj1mu8ps23jzmi
//#hn7/Ql7OcRxNBmIAXjhZNTfgySf8WHzyhbU/qs4z9LP7X6Te9v5tPculGWyzpjPUxBjU73yk1Po5v251sFTssnSQIuhO5IsCumSa
//#e7Um70+H5b2yoNfGt5XkJV2EJ/bixgbN0qf3L/C/IGaeimQ9E69zQsFU47KQkcUfSqBqaXJvXzUYl5KOkULqXyJYqoqTVnmgiUXD
//#xNRgMOc0ivgY8L79Z2IMmX8Cn2ZTP0mnhDdwJF9w+afJu1c+aGPpU+k/rR57zQ2+9OBWGCIRNwq0bildql3OKyR1KaXU+yui61nJ
//#n0/KLABWpNSkX7GF79oyHyu3cYEf9/2YOP1+0gGEqwm6Ea5ehLxCr9EI8lfy7cPApdYzQdcXzi5IC7OABs0B6ZiCMnP7NoTmL7L7
//#t0LoMsf20Dlk53iX4gp+/mvNkP4YwcJV7nlVL/YnQ/bxvHNvfrVhIhuR7ol4dNVznzItvjNIbnxmQRinVDXMxDW0etYyTLlPzJ1O
//#PdvAujLCuS0Uh3vPMQWebKsvf/DPmq6NBibCQJxtQB5Q7ezZRBOsOoUIQlwnSmN99SYphkG8N/lOtWx+kRbjiixHALhF2iI7lZQ5
//#t1km5U5Q9hVTINuLyih2jaVSjaiCJ4swNw4hmxbPuccBXzltwBQ4fSfu5aNXxVvn7Ez6qHxuL86shmWNr2UiKhkO+k6im4SP1eLq
//#wWox5PSVw4O5X6VcNbK7Hx61t9BEMSfDBBVBDAXKqGNu1OnzEhVfIduAsTGaLPYS1lEwzgT6m+cpPtHAmXWwg+nL+7t2MlUtlZtU
//#5deJpvqRIpa+7cqw0AgFOx7P0JWBfc9xn6JrgUEo7aAeXWxu+v4SKNt3MUodj4s6dZlyl5zzUKx9yodBlhkj2nOGIe4QR5se7Zhl
//#Z1FMy64u5XXSCVzMPNtu9uc3JKTtbepQ7tiEZOibvdILkzVIV0UDn7ZuH3rYv9Ii2K7IiSCzgdLvASfjpPnj5d7C/xvh9SgVSOYo
//#cYfGcw8UzCkT+ID0gwQPjqORGHpmcY8Ihs/zgvQDRZse6JqQTNQEqzYwU6OhRlWPhFJieJDlH2vYs2yjWzqEFfwo3p8tm1lQFAvW
//#wXypymkIamas5yY9BXf39XdWlQQ1H25v41xS5EYu72vAP6k1bITPzElgkR2mJOokiGkar4wz1TvzSAhZ55yfaGReA7o8QPjX/1jo
//#lYgvjisqtuz1EDsOo+UzD0/jrSCISk3yUcdaYy0rTymOT5MxtjuFTj0UxqXgIN4Jwe2n9/hPGdrRgLWSI3c+WRk7ikBM4IKzSRDm
//#ngpju8BKK8Z3wgn/kqIEZDkGvmZDbrnMNlJ54oucbnoJAO96a1NTpJktOAoomhbBRA1pyU1L6250hR+rwZQSM9EQHDbpuuHpyuYE
//#BNUBvVBkyv5DnklXN33KsrHnlW/anl/9xWi16cU/UoD95CUx/+M5kd36R9ePG9hNHGoGb648CmYqqm+hYc4mMOQifHGQ82OfHLX2
//#qyytu7B/gGjYnD9cGg2nbV8JKkt251h3L7fR1DrrFzz6GMPvYPQ1PhQNgcYviPrzeBKoVYSd0QJyi+fCjz1bhsD4Ae42BOJ1P+TW
//#ip/Q6utWTeuqqP8M/Ohbx+C4S82EvX8jElddZcYC8XB21AygRvc62bnButYyvPzurqWC8PtkjxUf2pVKuaVIuXz6xTh7hPCo6RY7
//#OSg/3PbpcQX8orXUGM7dMxnUyqBl73DoYWs6mHBjeF9aG/XUY36++b4/pPP8/mmamKOJ7jI79jdEDq/YRGa0NsVUjEgwBxx/3Z5m
//#kDakUt4L8qmwequc89s5epLRd4lC+I+IYjnT0nHyls4t2q44IRxarjd6EC+tuwpJGz1xPE8jCvyXPTSxWWr6zaJFjQQWnUs5oWQ/
//#q36LUa5FdleaWH7eXYwNW0AxSZhv3aNXtowX4wh/FkdtVNc0kpEqbca7+ABW9miYRHyf7WQSpufxYzpdeD1kKf8zTyvPbxNy45iA
//#9Vh+3CYGR+sdNr9porOnZL189DZ9GNj9K+1dN3fjjaMcl+UUQ+PTNbMPsdlrgdMeya/x93NCdsgEI3RkiT6CDRwHbCWHzAzAreKG
//#fcq/OAJDEylt3SGPqzLoTrWPoJgb3AVR9dL45yg5Xwah3Al7ltPri1RJPikUhJx+rjMzc7BA0drAHKyHXhkjNEqwdeAMBLTOfB19
//#0woKxnE4fCZA/gmNX0cckG9vv8d+RbrY+e69WT6SzeVNS37wpBrFDgPg0rlLnF5Jb74apWgKo9k8+Mu61vq0bogCs4upG7BC0b8c
//#o7RykDAipK+TwhQJ/M+f2R2Jj8weWDi/44B3QJDTVdZ8jr2bwyvIvOgnVbm2LDsIFsshE1TB4AA2GX0LfHgqOdJGgbICr7Go149Y
//#+RkhvRw93ywWtfIhaMG4y4ncSjvQKoz6oFFDeP6ns/gemeF0O1RYP6ZtqLXzbHzu4/ukiViMbwRcnR01jKK23IIGZ3SzLeEW6U3k
//#5P4nTm/RX4L4Z72kLI/QalInhlLy+CB+Pi0aKOjMRnQXT8Xho/h20lysaP2yeLJxNhaZFcJluum4dYCJp9q1Lu5eVyuMHlVqj1o3
//#hhSrvXJVeNPaZRyBa49fcnJ0HWnJxqc32OSvL4QIXQMYvUdud33KYk1KypzPXLGic497INjW3p9WXnwUcLKMYd0dBl3KWDNxffmm
//#x8ZTwZJHEnr4IyBkUOZzWO/8n18cBvFkcCZ+5iGicfcOu2t0piqa10sv8g9nGgBu/yegucy/uala+s1/NcufOAaFYzatekTB1Jyq
//#m2p7N1fdfVxn7MOwAnCehGd59nizJ4vtY5tZkQfoW8V2y0DvXqgUy7ZmaLB+SDfPoGS65h8TO33MJyNiFtHibvPYaubzKLYrvrqY
//#+tbGOKA9S5otLZ/dqTZy3WZQfPxazkzQgtS60er2q1fC9j208CnSsxCFv3Fu6am17Ob9RbgSU9b9v5g31zacHba7FyrUL5jFaffE
//#84h3FTFyV//7RjFMxWOBybr725Eg1UGqfgbSt5+DHjC+ApV4iv9Wd6MOlJ30I1QvnEty+xxDwdcqPrF95fOnw8fw84DsLmYUgjgM
//#kxLaWDX1dYopBsP+wA/40ZySuIOPECXAgAMTrX953ZKZ/Z4avMBFv6KbBq9gNmyQNIz2qPMMsS1VsMfn995BNL3rP+JGDm2G8sCc
//#9J9uQBh2U89y9EA0VUO11+hLKhEb2WLRc4YcMNDLjEGQ7AKm61qlnuArsPsD32O/2yHuCwYYwuY+IB+fL0T2CeaQNndc8gpvlW9D
//#a2lP3ojqYth0FsFiO3zzByRLHkqyngaOJLC8kEL0KjiRoC5jfKROo5YLjJFS/s5+yP4296gDZjYMm/dvJDiNKoeGIPZa8SAprFuM
//#noIV0z69a9AhjDxrFLv1M1uv6nz+ZmTg9H0IJg7kxHnW5T69k3fc9PdJUw8yqB82ENbteHiO23PR1ZIrrg/2UMEA0D1yygPeZJqB
//#StoBFGcn7OoqvIuFqn9hcQhFgbEEoAqX5hXpuEHtXxFALwscpbVMUa3OKaer4HUrCy86Wdvz69K8vW6lEMvk1LoYzt1hJWBjQEAJ
//#FhQpVdnd1bzgj05xFDxEbKIUAjX3m8pgReFvQX4rkGotveookiJNE97ywsfRQcFOlamjA1l46e6vhwjTGgSW/dzdA7NI9j62s7Dg
//#H7mbVf/Yo2Rg1Pbw8+58Ti7lfTpO0IRd6dBofRBCCVZMACrbq2/wnoVX1Weq2iHmJa58pzvEHrJP8tFdPHuPmIoeva8xjlprXcQj
//#PuwSlW0BS+WNxhZDYBtnSDt8mkqEjlk50xQHyT+/J/Cxf3jVNhVcxau04iblDTRLiyMMVjVu5JZvZlZJDRCLXLbBoGShJ+gN/kqc
//#N37Cn0bQ1OtoEmygJK/iVzjePCRphKqS+xOa2i/bfof8ZFy7DpOJ2Xqqh1HK2J3JdB5DfNGzsbJGBZEarPqL6hKqJx+OU9eDUjJO
//#m6bVhthiK36GE8snH0z3Sj+YwUlUj+vnl1Uw2QPVUKThJ2XFdSoYikhXjRb6SLo2i1+U+uyeDZKIr2NmVrKetzLiI32ODQdB5ZO2
//#2tsPMV70/6M5UazspDahI7xS7KrudKQ8jRRLyT7vKpXxeNFBrDhAegrMq/b3yOCWAGPIiWL65XCGNXhameXgezzsrTtaF8gRUa0K
//#TU/pdHJV9BRixWPBHE8O1Fvd18UItPFkZ0sxfBcOjOK1ok87oOOnUlUXDufnBKePzAKzC5hQTc6yX4cBjUQg7qXEQyRaS5oBfA3B
//#Vw6xTx6FT/1plMvO81PNhmOlp6N7ob5dlzNA+pJUiDrn7ynIbF5ugR6OLeqEKKyiyqFrGvRSIpKmCiCRTiF9NtZUAeHAtTxfO6qj
//#wGZEVxhW73Q48ryiA4KaY7pCwSor8IyHE5PAqnL4SwpAeYkoA/u7reo9yBtTewPEXtrzMGWi94vAzFXcAVVaJETCiUQPHoKXYLBL
//#a/MygutRmlWOFZnlkRn+hHMNjYtw4qRLa+p5YG55UhnAEgK74MlbMlcUt1jW+a2QO6PwwPW2o9piFUUQQYPFUB5g93FuKlua252m
//#X3pS9TZ0yLwX2CpBZN7Hkru69JHPaPHXlx4FJthMGWAt24zv1ithVB6jrgsPIDkak7ROZANivJLmU3CKkNe/KK6sCGrfqEHgnSpx
//#umPt/lorVkjJ6dsH0XXRWNG5pGqohr01mwH1vZVroZ87Atut503oN8g4Gwg8nHG/sjMVOKFfP88ubCpetk5YsNtKN9ZZYioKpb4D
//#a/fuAHnJH/nN6HQV5pvi6oukxhRJL88AovzNbAwmwwRLZbNa5j4luq+2D+cX7kZud5l9/uQzFvnr0owBAz/Dx7SDSWKN9UTGTLwf
//#H+xeSNHLjFqyJT7gj4LUNBFoXyxI7pdW7YDzhElMV7+wGr66AcEyNeZOPuL84DQwp5OpqzXn69s0lKZVmKXFgvLGxf0BUX1tba43
//#Jh125IWXtAnfypj9mcERVepT3ISm6mhJtm28G2ZD44OQBXsM1tp+oCo8Pa/zAW5dbrTHrvG6xk2ueVRDYc4wYsh90Ix1N2/8stBj
//#27qbJADubB0c/Lq24Cd/ptnOQnzhF7okMXCrlrjmUz3isKcxRzqFwcatT5I7wX2AtN3NJ3JOto4DpgNdUrekgJ6DrHYo8MrnFV3q
//#KBG6w4zj4eDeDIEcN8YJoJRRLZjCzJxTZeFkbiIAsHSpcBTGsYp+qSowrREKv7jWAcZu6jY1c381qZGoRF8h5oSu0QG+T7BYyFYZ
//#yaZimfibHtaJGkHR1W3/J5Bpn5Wyg+tgq/OSBjtnCOB5WwiSRt0SY3pFkXJU5UWGQpi0MdF8WJpyBs+ou4LpWiCYgErqQwC6o5l6
//#mgkPFFEbThD1qwRFkaAV1II4dPoEpJg9gkn3dozwR507FZ0MB5QWvtSwfG6VPJrspjbywuzcFEdEJgz1W3fzRD9ZFTLLTJEJZuiK
//#uTEnH/6SJy6/X7tnTgZ8lzpurtAKLlfIb/Kac+WCMABDpJTYbK9zs9+9GmGaSIf6lUvDIqfKv5Y6XkB13WrU+fZ5YT5b4lGu4B1+
//#U4hWR/JkOgozZRaUUebM2/eUapKlgWOnbxGDgS7u23TS1NmglEKO/UTlplKhHRXSrpaNJZGCvspMq3RxmU1F4UCArPStdmZaSdlp
//#dyL7srzsI8zELWifBSYHKoqsEtYFle6RIreE4zr7MUiysaJiLkWVT+2qAwQMLhNmLnmvIWEHz1J0bFpBVhIT2k5VrHdR8bk0efk0
//#l6IkS86qrLwt3ecO5XrqcUHDlzICHIJ8m6xCFfVDpa4lvwxFEsUyJ2m/eLR0jhbJ6Tz9FLsHG0GhOPGPnMERmz+9NPjPATAOwhVf
//#jBbY2sDlLd2cfUJ501NGggfOupY0u4A+fdq+Z0SEZRrBJ5f/mJpG3UxKGMZ9dnqOxvTK85OYqPcsMX+Tb+iaW6+r567v/7aOz1Ux
//#iPG1qKIvSSAyKq6++tecItBPReBIh8x+39i/Kivc4NEwA4Q/r/ZRl9e0Q/pmbUQweOa/oYtJ5zF7RcdslLeBNcgRCZ6ZOnIkiMlU
//#9/TK5xCuLOkoxFmXM4ygoowpFuInqhjkneP04YeF/J8vRn2C7HPN8Rtchp9E5drE7U0Uih6REfGiwe0l+G/M0LJLlDCIraykBIn1
//#VF9uepg3meGVDeARLQ2J6y0fwVWuzIAZu5DT6nF4J2gyKm3Kl+afsj/XcZ7QOY9IdOQlyn/x5b4JTiXmk13PbTs+tvTMDFt7FCHU
//#aK43XQZe6/TUx5wcM3ZreV5m9MIoXzKrOxl5JgjUDoTFqj+qx/IXOsxqvd0GEOXnBozvRgfVOhkYZuvfDduCvwXJ0dHdJqS+A4to
//#ctSGT5gH1bWGd+eJ+Vuaw31a3PcmyR77N2yHp0GFpxntO0uDhs5aJIlmvJ3p0ZhHAtZcTV33KoYT/PK73NncYemBYGmBXcLdLnyl
//#JVrB2ccAmci+tHnmKXyFlMYEIi5zmOzpALIlVoCJY4EpEUf9NVmYp7MHR/v+ZBpWiUDCPOmiR6YmPl38qb4ZW9fVQ8mBiDMbD9o8
//#L+DehlwSiiGN2RMgd6NM3v+kdRgeYrRZyko5f0JNQPJ0KPFyttGTHIjF1hwKQtTWPjvKNDFYnjMX6VtuFAmePcSinz1S5DMBn6c5
//#fvB4L1tKYvnVAucZfBHbLqN+9ZSAXM4q9XSiJ7dQJfc9cmVLVNDS5qnUEjqUZOLPXcqZZ61UGXmAvgzmYSpiz1QrwFLkIxhRpSY1
//#gizzNk7NHgTKc8oQXxvWewISt95Kh6dTTErZmQz4HdAyoSufk8tH5yv6diV6N1068UB98RDnqKXNLniblDsraRqJTkCG9ZgJRiLr
//#1Z2+jMK42Va9GfGsRpzrThC5wbkWT4PMKXyyIjTphb4xvXExL+iKkD3IQcQkKRMDmoZ8vWnCzKJZH2Jlx4adQ5PlmTjazun68jlA
//#6PKVHA+c6aV+tsGOMuOF/5WHLGKQPub/vl5josZ3SW1ZSvoEEAKJZ9Zhq5dPI2aSOMgauiZl2DzXAsSWUllp0IuRr3y/2IdeKKxe
//#AdH32rQ0o1Q9f796JwpYCdUtEf/r2qFio/L7d9h7m/EDz1L8qaKSb7KuHaC1FX+RO9j0+kO66Zr85iFicVjDc1lg3I/KTes8T8ds
//#kTSBGueMTFN/OnuOSeYm9Kbw1BMWMLAvvM8y4+VwDqVZ4hLuGCUIAT+9zKj24mi8hWPNImtFkpR0Rog0ktbS/rrntJ+JDfnsjCLZ
//#W/YR8xPx+1abV/3QoLExbDMBhkzxvuczKF4iJf+2Hjpm22yotYCQnqCxcmWQ44G3HRRPGZD3zvDVCOpIcJ9zysbz9Q0yC0R54lEx
//#E35sEvJwyDNsakbNpk+R1AqcW+7Z5RUzR/DxG8q7i5vQLrQZgh0lRUQURguvNiFCNWfT/eQZOmTJpUDeD6sI6v9E24eQR+dHB42Q
//#eGP71+QuwKe0qQcpHdcqkXBOhsvsETQRujcSaDwFU/VxtkL0pFO1LJ0bMMWSVkaVO96Z/MWdMk8MKZVWgTu8lOnjs+Hc8JwpMNxo
//#2Nw/n11RQbr9fkXj52fzXelEveDhuSh6orv+YSrAt8ZiQSsNrLZu0iwPaax0LL1tp0miYkUGmDB4TXo/D+78cn1IRDe8EGJ0D/SR
//#M1rcPwsXjD5YHja5C9plEy0AUsQigtAzJ+8/db1hn4qeAHzzzDXwcOp3Y5vG6kDQFuXqmDC/IB6N2sF3mrt7mq/XxykfmntkhH8U
//#dUJpa5VS3CdcICc6/VunK5xQwx6L76iIfj+fkyoafVUy2UFbEqy6Uo2HZLeR0olXwHzgDcf0Tznv/ZA1HgqY3kprJ2mGV9ZtKRm8
//#TCmMyVzWVgpdATp5BL7EiqehwllqLJ4CuGz+lESCnlLMvyTsKtdGsUx8iqc6W9Edj3NVZndQFo/tqlPsk2Onec5Ft1ATBAkyvzc8
//#PuR5SWdTeSi5Te9QEqfUFw6k/ecMGfHuVULmaopDV0OWxcMBo4Qd7PjkIwrm9XYI+JY24aD00Bywcxmhc2f1MDRPgBfrIXY3In4Z
//#/Sw2HQPoRbqx2ndrC8NlCPa1NwrOyUIcTpw37QZP1QOncZ6qbJHWcMu5koH3QCiQpmTdmSoMD0C9Z6XDuNWFfKWVLAHwEHnNzLnu
//#cgoN7izIb+lLeXaMOrcqRWEg8FS4kMBSAJ0uI4Mxmsm8P0T1dpgr+nb0osogm3eJgTWUhMKAfrNauQWUADLWU7cz80HbZupQuI97
//#dJqVL25DEZgInC1ql5re8wIu+EF6YN0oYxRF45dpR5pLIz8HbiqN8yIwptFTJ3soUFSokxHsuFnbknjOY69sPbMtv3oXfSvJEepE
//#OlpLE3hdqDpVx+M2yXsQO3Y3O0PsQHfCkBT+t3Shf6doSFQ6IEyg2KIH0XtLz1dK0+I02N+/egnq0s77WBy1TPgrCnKsywZH59vW
//#vfo5ZVfU/QFZHta54m5y09Xtn8tF+ebzn59PWYlelvk/pH40pqyXIa8adVBz7CbX+a1Z9qGl8Ra78FuD35+VbhXafsRfUbtWceYX
//#8Cs/yHQUNRzg+pmIflGj0bGZESyR7nkaz47U1MIXU50RKOwkn9zNbxFwwdPE+ujbuOH3ecnVSYZ+v2PVgbjrWFhqHT4RGiFMTlqC
//#//Zl97oi1b7ik4/0b5zZRr/vN658rdiFbKeYQSjsddPALKQkjXgXE+4jwWJDfJG3GR+MXsZErOmwGPqAT96CD38KfpD7iLPMZZhG
//#7e5NzI9tRRg7qzEprmrQg9hGjhyFHdmyzyVdHii99f3EJBcjQY3gJioqlVKfGTpE4Hc0zvodG/18dwCs4Fj2Bh+ozuoR+ec0h0J6
//#bESRMSwaTZ3zjh4zp1hN8sY/nDTFyNsT38Quavupi92rJFHwmo+6KaDvIA/ABQoKKYkQ0AMkqaUYdi/BFPrKjp4DFYOiSxDeiMRm
//#qywKq4fdcnHpRPp9WS18KSYdgb0rLEdw7fW7nHZs3FK235ex10TBOgBxxzQfxSW7XG36RQWfL2zTv9QzTc+ii+O7svjJnzeUo67Z
//#uyf6OUhqtdfnp7epHmqOp2o3ifkxONW85qBTSvDP5vYtDTv4HizWCFwED/YuZh2Mi8iN4JsPjjGZ4AtwnlSsSC/oQuHfdwccQOE2
//#kxvsXdKbdR9hGju5OphmdHvvWclnD6K7HZPG2ZGE4xFvh95pjefMQrmkiEzE+r6aYHx2ETgJWzIY3cJfD5hh0ZjKMB9YBjNqm2g5
//#+p8kMnVnzWA75ejQ0R7UR3biDKZFqqgcfCGXdowu5DXV6Me1V9JgNSD4AmIv8p53ImcNgLXWbJrD0uSgZNfeEpo7//Ari26Sj2vO
//#nrF8G9i57Z6MPWnqinU9JNG9VvTxq5RFD5FxxTdm0gZbSdlCaDOwYGyvAnPj0HbEIWVy5+BQoVFKbh58cDd+z8IUmwDRL3jH4PWn
//#y+uvw6lBcBw/VCB0Ln1c5adQCkGo14aPgCmMwA8ad/J74rfcDpO/wdHfuxX6hiwY7ugj8hK66GC71A9ur5SCu8IK70m5LYwfsdxs
//#PEi7SAzd4wcOZs1lYiag7VZY74Yu4tXCPAyC6s2GcGx9zYevgkughQHVanmKbAMeMFVCUzjIDDNP5UJu9AzX06N089Wi8/GLz0Wv
//#dnyYsqCLu7irchQXO5bylKTyKSgSOME3rujlbSET8xVgSl32RZI7X/kKRHWfKrVMTCJpZHIFTGjDQOXXBYCMkpe1wa9c57l0Ike/
//#ayG4Q6+L1vWUq0pLfJeT/u+adOuJnVaHmTQKq3txnVG3FnuVUqHHesuuXqTqQHC6uNvQTkE4pKKEUOoxeO4njA+C8OaDBLs5Y7bd
//#Cu397V8AT5m2HuRnyZZRZ8DUz6Amf9x/nphgm3DDvT+VTX7qcXWtIgFkKngmGOaBVX2K+e3KMunWridRCJP5K+19jleFc4DmhVaK
//#4YIxKVzTXfWbkE+pQsFiJa07cQ8gOrT7g8aZo+TCMA3UeefdzV3bcE5VfYXlNbug2/PSYFggglMIJWV+4Yh13XphVjSV1YU5cly6
//#PNpi+VcKh4YZlbcJFsslqoWcRR11kGWMCVhC9jvKwLf2k/1QzLZO9bEJRKvFkRpNdSQ2+HGvqIfWztbcyqmPBAHMFR1Y5iI1pXXh
//#Q3uAa1J7g7HKimqWMivWer/84rVjeUwktOYdMoLFssLSXV3NdL0dYfKWtM3KfHJ+tqXEH2f3QCLQN0/0B4kTQr14z5kbJEqGTEvS
//#J3NQcIfPMp9paVw3zgKuwk7Jk3h4EK/5UBR7bhG1tFphN78VRk/cHzBK7RPftTabKp+EMRQic4Fe4iKaMlM2PxMkKDuo6dHGLPrF
//#w0MrJV+zLNh5v6qMA/cZKanc79J73Qam7LkHPotU0aGMpX72bply1cu16yoY5IxF+FLjOrS8ezYTpT8uWzZkTitadYNjTKqf+qCV
//#mWhDw1e0mg7g2SphfNJRGm8ZkP7KmlsjV5fmV7SUmqQ/zm98aWMpGPWV+z7mJemHNtnSkhMIO5Kf4V3wEawtA+hy8CkEiSs4CBXT
//#qdrCeyZyfu3OEhcGCJJEUsIGaSKuO3BEXuaxwIi/8RRp/yLQKjMVy9XjATibsHysvPeojY1Mdox0JSHZIR4ksdCx3I1oNA2WcrZb
//#h8dqezrwNMrIFf5Ri1VqcmRLrWmNzwfjhjCaVevWJ/bjeabfG5zGDwdF4eZPmych77BirVGwDb1aYGWa63LtLCif6Bg804mpEFF6
//#jI3VXab88yKF+1fe+NmVQJ0MHgS4690YjtAi/nbonsOchFRc5Yp+gi11nKUk0Ij8MrKrw9U1CR79Y5ZdctZ96/PMLZyUQOO7B3Ql
//#KYobzcSITdGIMr6yiA+7i7bJ+fQGFQLIDEkVG6MrZHf8XXhYa5qsAM3FejNmyGOppmEtvsq7SmCM9ltZ9amz9aA5MpuOrBUNX0jB
//#7f7qCnaQhan+KgKHSkcAgwvu3t7u3ds5u0I49g7+3m6YiMSa5pxwh8/375nHb/OO136h3ZuWJxfxKQxzbXAFspaOmOYl0bUteMeP
//#Z/v1KLl2irvqeEY26RPooFDEaw/FObuVuPeFwhJUIEWef0BWXMdMBVefYEmaW0lymBKoh+McNbV7EYaFNhZSA1vADoUn0xpjm7LA
//#nlFB68GmJwMaPCLLOtqp5XYwcGAG7RfaYdg62OUX1cX0JR2IWdL8qUxsyJcL0U1sUbAYFksQUirrTHxXam3WRcKEixC2aimSmLal
//#+dC5oCMKRvHBFtKMAgi50Xdj6KInW1N9LovQGbk/klgS5s3Xue64o9LE27kPN3Jkwq9q9rHJ4ARvklXEzDDqcqXbSgKQsey8aEEN
//#a7xdOmf6yo6RxjuDyfg+Dorqfn2l1iZ0gQ72vEd72+LUL71uPtru6cMViu13F+UeTI+ziZm/nHHdVtUepclxrFI/SUvedpmey2q1
//#gpRn3lDfQJpBWLGRbJeT+/6+kdWBhPHsyF6KWaeLgcYG+TxjCYHoS2CYZCUVpORrRJr7/W8+XfodKv7/t1wZd6xYHHwjaRqvjMO4
//#fejVpCMYWgMirvp1rrzCF9abCxRQUmkn75j31OCaWs2yW8z0fJJaH0LOxOmQa9+Sw8fDfCalcnGG2A0fkXppNvDKD1lPG/KKf2rJ
//#UteKJpfooQYyqbugan1iYLgAwYIGZfpaUibPBVe9BNSbkKEa3KjfndtJ9gTn8HmBoVbk2P27BhSv5J7X624ScicPHs+cxE3y/R6B
//#+h9ReDg1VKBmt1pRpDupxgW7DerAQL7S72x7nqsiWR20cYnili6u60hQDIc1hUsTqFiBdh7ruzhfATaidyKcc1fuNuTD6CtMa9L5
//#9M8YAoQhav3WW8V5TgbKtuTIu2ME8TXhxpF3KXhyxsl2S4zEl7f2LKO69hB+SZ87ekkSMZ5UZkSNE1wfsXQhDZT84HXD4VpqAEmO
//#3A8Znrw1NiE3ynC7Th2gwvWZ9FyCuZfAh9LqNg0EMl5QDzTkqgtYHn7mzzKWXLsjcNDefahyz9EtPJej8a9tytA2GOd5u89Eoj8K
//#CN74Gu5u4jODex+Pvl21MZocB1NJNR7zEn+K7q7z9UcQ0Y8QlThJPXvbbi68xtFRZ/b+sQC3Zv5iS5cHriv8y2vpT66bg1H+e2M/
//#nryJnjiihj7oDmJlnkm6pYa4IGE4qOMv8NxOETuC5ogREYqtHtdAQDNwQ/AJiBKRJ4oLgNAsiedLcSab1tnryu3sg8xxevfuL/cn
//#h8lKI2oXoanRW+sK8GeJE6CsY4dwPzn9SW1mOTsRTk1qxhJEiBT9yhGM0wK57QsTmHBKr7EfSNJ/CpC3PFrpPSYzApBk/mVKm1AO
//#CRrP8lFtBg2sTzGQGUFgJWd6ZrX6SMo2nEeB3ZVaRf+KU1GmJvS1KDVI/02v4fblBpHdwlh8UxownfvpeThDPJ01RHjWr0AvCHQ4
//#kBWOltzEVY8bvZ96jk3AtkVDVI9y5YNOtyViw5UN4gR5BdSUJ2F0PmYnYxRDZhBGJAyswB8akUyXR0Sr/iDInQh+hYgrXIQSbN0x
//#JRHd7LhIKIk2VQxbpd641i+U3ddMF+wuyIMlSMYqhYlAg7gJPt9iLPIH/8x5q//WUo7VtkJwea6KffrPQ+qKYJv8jwXFEOQ9K+Wr
//#lfAglXpvT96q579Kqpo4EzFBa9NzTP2B0ANSHzjwBz/rY5r1BFfpx+IRI2hWU4kBPgtUvtje6OSKJxSpQc3RPmapdz+maPpCnNat
//#SotXdUmOsSF7J4co0TYOXcWWM0RrBT2QpefvUn0or1K3KZouYUOGChrEeJHDkD806ITlarFhJvB7DSzhTq5ed8Yt6iIbs9+Zo37r
//#2ncTGQ7wKQpwtHwnWDVmnUDF2jxEmDX0n7x38gHU+Ljyl3FTKI93rTTUdcidHdvKzfxpDBFdytakNKmZxjPplI3iY5KvKZlFpt2d
//#e40r7YglNJzlZvZMXHgRy3fubEa1nVK/CEys+qrdO4unuIe1pzhOu6r52VGkPr9qALNpdDULNcYXSuXjEIGkLaVWAPNhqrmV+cbc
//#nQfQYHWqYweSykswoRQrKb80QKashhi+JNajKSMV9jvMMdbSqprE8HL+xB/N6KwY0/dxG509dGHD1BJpZFx61otH8pcxxy4OaT8b
//#R68LOVDQ1mYtxDZQ8ohAU3nBlV+ZzBDBozZdlqulQZPAJIIxo5I+kutWHVa96v86CQTwLAJzrfpwmAqNK7aODoRQi/LUq5PihMd2
//#krKIhwq7IvwVSqg1/Yx20GrxmsZuE99TDKEsHMYRSpc1Eii2D3SW5JvmHDefKkcfWS91xxcaBMA4d+zvA/r/j28/Oh+NM3agjZPP
//#bMyEoptrL2XLDsTze7FK2s7HpIPg/GcbQdq8svF+jy2Lo966rByqyVcCQk7717IevVsmwJRQBlTvyXvAstzKgY23oSitOE9nK1F1
//#9c+Ruo+YdcyBwMCgN/QRXUNRvxEJIfK+5WrAptKX41fyuLefdQxdPSfReLqSDbsnKpJhySBtcR/3EVnUGFtZGVYL70vlpy2UxnTx
//#QhW+XQ0Hg8kf0beKzJHdKTEx71Dd69YLhVlVJr7QZ1kZWsDaoDcBf6XV3N9XCReGKS+DigcTqzlWgdpfePo8h+mKfZIIKuvtRcg/
//#5VSgPMWHeaTrs3RUa7Kaj8Pw/ebt1ifq3bJdbe3tN2+HVsWiXC2GuH19m0063OPPwftwebhCfDBIJgCIgfRL5W2hV7OlTs7GzWfN
//#9t41j97+msbQ93HDr/Pg4eHPeN8IMRS0CmmGj69/u/wfTAKQRlEO/MohFSJpiFO3sWK+W7x053gQ0guopc8UUtDO6XPR5V+ZNc4o
//#IL3f0zVuKMPsmKuvk5qQ3hObLLu/xLdOf27Qn3rXFFZcxbLNW2HmAc1233z+mYh+9s/hLRlBiUzY2dBF+tYuwS5iu5A7qxo4UmM8
//#6RtqzSmRREG4sblnRl5bPnc5zm0vm7k8e2Utxnx1I1nG/vj15O+d89BLUSMqXNQlzynyNTTlr/YcqAH5S53d3EVzyxAmYJQ6VzNa
//#NLNqAKqeOZgtyMpFtzjB08ixylPBVw22snwKxaJABzkAajhX/2NWdun3I4/Hgxm6R2OOBqxRbTHVQGTQgta1TKtnu/qwUhpRMMYa
//#Rif+EttjZ9Bnu2GefJsRAPCMXyR9xm7jGh5B74nFajFGvnSq11PjcyUx5C+ZvHqy2F9dp4B7N5TVfZ86bc6LKL0avAXKlgcWNmm8
//#oj/uqBIB4oi/vpvgdBy6aqjPYogia/Mcdd2Twdh6LSuyx856T/GJEz5jdq7/jU/cjWqU6MXeixB2Ma3365n7IY39mOglY5bRpr+B
//#LG0rc+32GHUBsf5VU01UQRuP6OARyfXd1cm6R0XyscOZvbh3ECq52neLAo/ixRa7EI5n1Sh+81nBz2WbTO//YljpKUdm917ZrLc9
//#10TED6p9YJbNR7UHp4bAAwH/Uy1ouUWx30XkupsbX7E72BZ/tvs2RZy4BGv8qtr1EIVFvdVQr53J75pENe7l5nI5JvObF+MBXjdP
//#m29Pb2er2L4z1u3LtuO2tdSuwxTrLKj/F9MlDOWXLREPInJQOOTWjQ8wBLIOF9mywFqbhKiLNb9LD8HJMvM23YL30Z3Tg7i6BopN
//#DpENc+LQHUrBZJ41eshjTLvWqvDVVbqnT3Kj2fLrSFGLPFNEOCY/FLGLlR9vx5bbV2v0fm41Qgs0hly+JPBk7OhOc6mwEGATNJqz
//#2mgn3U3C2BIifbZId1WEO+krbeuWdLDLyRrRxLUAXPUOQd1OY5enONiOlwMBVMQTsdgwIc0NCArwOwtKHpGYtFAGvvguM0bmX/wS
//#gzfyR3wO/6LbVZV076Hb253XI/NT1zgP4tnxwfiAyfQ0+GFWxi6m8V3pWJO5uFSQI8BOph52FLOqRdF14HjMWla7qGEIW4hsKML7
//#2ic69tpCTjGwpokvUJHI8uDlWGCMY0egNMFQCJbbGoX3+UcT6p2tPBo5B6Jzgo3eO1Xi4CO594heRrZ8RhpIhOFyZ7xszGTxY5Ei
//#5ebkkvvTKHeiogZIvqf7wRTFgmlZgCS3v2GZB0zalG8pFzXJ5w6NggeQA2HGIxiN6+wEVKBPqeFPXmK5XBiaCjPpSN3n7vvkok3K
//#+mmTAPTMwJ4K1ked1pBLUdJ2CrDPdR+u/5aZ2cREe0xz91Jj+lLBqhMesUz0vMufHvhwsw0buq7tqGwteZJxj4/2lmgbTR+blnrt
//#v8383ByLS71AjnmzRVbcFUY4V82Bn/Ox3z4U4vTU0Y1mPpgvjjiaAx2TyGYeNiEace2bPN0/R2bF0dQDUVbzJRFFGsMW35F93xzG
//#Kow2Gjhdz9qfe9g+fDYCL3sCxIDuwpYwjeSzD3U5ksnFjgSIhW9RTIFJe+toqefcpOdhh70JgWuJYezZig4yhgpQh212cr0CckNM
//#AcSwJgJUpOeGaK2FYBUGRlLeRlL+i7QVBvA0LENpZx/gWI0aSKKedjh+F3nk4yZVVNE0kqqiS2+zQHEokpHghuQLdhZH1hx5tdhe
//#6KvopAVLr8E63DSjnA1UksbjTUHV4pm5j0tjpV/EGnp6m2AnvkJMcFEnCdoLthGCUXdZFhHwR+rTtW8YhrO4mZYU1QjRDO1dI0j6
//#kAJO0YKFX9EAiRem+a8MDmTUoT/g7ZINwnAgzj7sl4plKxVVuzcmU2vqpqlhKtrHNyNi/P4Lw7lO57livh/PeSl+eBqpvUfmVNVR
//#CJHbQYy02AgkAM6RK4+jYYp0gjn7j1VBhAf1X31D9FJT5W8zBaaufloZ+7IVPkpsVDkoW3zglBgR24tfxHbLSB6e9nmx2n3jP1/T
//#oHvDa6a06YBrZzEh1+DLcKh/pI7vAbCwR1emmYb64uAvzuc2HMYpMoX9ED2qGqZaGfCvSeMbJS878WQd/gHyKvGwJiTXeCEExIF9
//#8rg0RtmKOBHWuU8xngEoGLmZ7MKMSRxgWCNXwIktLROslOUxFgmIGb/hA+Tu2ICTuaJnjylWauELAMlhR1m4m/63VAKyOLKF2KpP
//#1v+BTI5ckiAuEBSySd8Fki9W+TJHmdskXJcA0wXu7KOOwqPOME24EtA6yA23JQiLfloQyHRiFX0R9vZykjjnWDuJVR5N/Zncr4ME
//#CaiURUF/P67s8dvdzYOrPu5ZfyZeN9AKbXoiS2gvKyYKuhwq2JSKWRncFQT+duGSfSudzXtipzM06bshcyKv98Ns9kWTuBVKTdG9
//#M1bNtrjapKYdYSQrg1GPbgrZAzRoP6Ty2gRPMyEsXbt7KAdSrgpQR0qGnCJk2qI6nsQAthvo3Lg5MfiEruicPpsjpke+URoGd3pl
//#LyAGH9CjoxKaynDkMDPKeKAsn91MTU145qYLMsosLykizK5Bd3KfQSM8bwBc0QrK1MDjU6ELCTlB+8Z7TixK1TBjUbAlQIw1ZfsI
//#ziW0QaamiHdhiVVDxhL2E7qxLOWDI8PSb+F5n/6cDoRY1OU1Nvul3H91Y2cZtOKILH9XDJiflm8YFj3E1k49OdtqhlcMz9DMQD1X
//#5OJKkW1VZdLorX7vgOqLIXFI2BrTDBTYszYzOyWeCt/FVAYvgaJPGUgfizSQOR3IM55mrzlkFxd1zSOTiQnWk/EV+Chf3rSRwWg4
//#hN3B6wfOOeo0NXmmbSPDuMyGQmkeBKk3Kj/a9Lf+1DJ27bqJ6WNjg3lAe4sWG9mJZVvLxtk3X8ducvFyxTgYVDMBk80wxbCH4is6
//#XSkaaA5mrAOummNm9jF0HTka4m0pYE3DjsT69Ye3VsMczzC4ulPmg+1Ky/EqR+qmb7mf67fLN7+KLvnHW+moaAf/OTXdOL4m+1ND
//#xqV1pbOmXkJ5dhiQvlpc7KEpJrIvueYKlYmaVt4yTxUt/564TLPh1dptnVKs+pNG//sX7kFhWVCEqbx4d380epY2Lp9eeWo7UG+2
//#8szugffkdkkxeaAxGH+OiftSIU4ZPuox3EqIf/K8CrTVgCwHzIpKED2aGTbtRPy3YC1VOrSsD5D+tFsqXP+RteZ0Cxlq0PV+WFe7
//#98SCHZhuigHsaq2Br2AH6RlvPihPmYeuxWSdrC6EQMwB/yOYcm9N6eCZgpq9Hl74u/rfiSWx2B46RyWqum3XraozQFAm1MQLfdRI
//#in6ZHz6ISk5WypuIWyDteGuXCY5rqOa3VR9ltBAMUqdGhgBiyxOdXwpkpbLJFJD9WewiktfeqK6ogygAXNDyeDV4Z31OfFGnIO8g
//#TCA0rkYWDVXQXuW8VjqImEW3VjfPIiQTEJ5/hmGz//jcNq4wq/GBlQFWQAzkmY/8yoUQ4OL5SGpR83QBRyJJH7InpKdcE20E27Ri
//#T1K9GOiwoWhoDp6paYHuc0msOt7BGY7c3Lvg6PYMoRV7DeG3n4YUagOdYpE2lw12JtZfos1IQsFUZ+Y4PvYM6BnkvvekxK9h4V5r
//#xxJvDVkkfUliXYmpAieNkPHNx9+j5OWXZUuObi4nFyKgUzWhCAhRJ9iRKFOD3438j8I9pDWqE8XQhlPANIWPcGZ63WRB9oibInPX
//#9g+HyIoNhPkM99quCjQ8e2u+1h75n5nrJ1J39L4ZCXHp1Acxm723tv3MA9uPG73t0Qc3LZXuStTYDO+ud8HIE5dPeyXxoMs+Ef1p
//#h0c2YyxwUyOwndvqv80Xd104EO89LY28+ewUq7uod+wM57en7GT2GCOYdh/Pv7yVAxPqS+JRSGKkBMhsxilrdaMGrwSkTRetBr92
//#vDht4cExSeBzNhcqwkCAp0m1lupR2oCUVAnFXK+ejEKc03JiZLAIjIYA5JFSDkM28XTRG3sLbyXu1ZP4l7/rX3owPccY88Xmhaqp
//#RtzwzzKOhhh91jIAFV+nc4XBhuvYH9JivPoxgIWsZPw/8kyV6DJqYELW3N7Lry5rBaPZs7HIo8eZpRrVBh53g75E8xsqd2NSGloZ
//#W1sSHhKN0QInser/DdXuvsAexOJ5JLBfWaELHHHwyFUN4JIAudQ27X73lxKW4dTTVWazpRry9pKpWb9mDFl+QV3MVQBt8zG7R1Fo
//#4D1PPiTZvSuGehmloU3fR4pl+IKq/R9/R/n2d1t/C8pEjjMczJStk85W/7CTjK29NDHHU9qqtEPOVNzn6ABpqjXkzFSHpvhEPRyB
//#IILTIyaoI78WqZIZgVhKZBWTjDdI8mCOUdbtedhaYUTfx7gy8oGZSyVbFcGXyaOblVmANCMQWBDiOyBAIYq2iFGtRHbiEsiN9SCD
//#KXhIdFANgFW9LNq85T+er5tt3liJSsq2n9t5GZneSD1/1JUq9nwVLaUOPZmZKGxkYSTxJueQEyI5CkcEg4hBDypfbztFzv0mhucA
//#fUhE70lJEQWP70scbO0hNorMAPYPIu2nljnpuj/TODe7CbD1rLAHD4ZmhYpqYKWMSrY+txP7HCKXJj4rFjJHmBlOa82MBGpTFXYO
//#W/lpsSNUH8f/VXTcOJDhv8n66Xjz4/3D5Ncz23JNvdo47nuBN58G69r6506XOviK7+/gQHigyd2Lvda2jEmIdal1r6W0x6jfqHNX
//#kCzt9ue68hhP14vmheYm1e6gUSq775TGxA4PcZEcWQc1b3xFDxu4dX8h2OkE4LGGGIz7V/hA0XCHhdTvbtbVV/WcMMuIWbisutan
//#psqNq+8p1uzczKrG2BTt+q61uzObwkoobgG0I10nlmFOotgBLd72iV/8FFl7sedSofpVhjOHrsSCsBD2LAQNARGdW0bByXRpRpoI
//#TQqAFau0ozNImVOUgK7WVBgqtK77rqp1LxknCfZHam0KFjAI5gnpSBJUo+Pc5TmZn0qZAZ4xZJ909uotmOIUTAcaAYHWGA00k8KO
//#rADKXgYGrfjRuBc8gIBci2CjBugY7uEp3C/1PQnCMLvvxK0+K2hlXFJb+pM0irdf9prNqFhnM2cN/E5sdnOl8DqBz5/THA5FeDzz
//#YpquP1fjp8DRpGQae3Y0HLyKuPuPmFkqBknCTGGDZ2AJXxKsji8Msk4MH3cVOzN9PPszWwmOynXZgQPk+uzJBXJBafqhqMLMqPhs
//#OVpW9la7fZkiXDEp6y31DZvOKzivYiAj8pUPkzj6bBKa45qhHKS/unoB1FTZsgxGNcOtkGNjqtBqZ2u9qoHjGyLbBH4ID4i0oc1L
//#VeXI8UmCMUOtL2ITij1MQ6u742ucidTO/WICYZg+UhakXWlfgSgacfpvxjRxu6D5zZI5ZJf7psC/G/GfjhPFOoso2ZXDUWCNRJJl
//#ao2J54gkirMKElBymQ/oc4b52hLEaCIOmiqW/xN3qsQqdNeP6FzMsW0n+pNRaMdHiaNlJydgPY1/bCSHdkj0X+LyHozbCwJa2YnH
//#oi0BiABjW+arh2zrdhVNhKevlgzKY52gcwoHCMTvrF3aAF/A/uTpP9m0LN9WmA7umoyctRl+/tSBnmMEnb2BEXUMPenSRwEBPB8C
//#kg6LMQS1gL7OKbK8PPC0RUzRsQFjIRyus5uiRRPf5UCfbxas5P9l7mj/qIG/+PUO2YBG1gjJwesGCVEqYBaF4Y1rWnVaZSz9vUQY
//#4zOKzSExKAlCiOUKHhgzrhcOII3Mv/B6xBeMiZkoZQnNK6HznNOsERoy446C7eNY0YVvjzBTrWSaPUrTrlMSH2ZSNt6z5HkB4++6
//#lEXpQpzbEf/Qnr2UTm6Fq9yt5pm1YvlefSBTqMNip7fR7JZkE9MQo1mOeDdUAp3Eor40xZwJmLymJiqgerwVlbQyeq54h4JCZETq
//#JlZCz8PNULymwEDvEgzlx2ObLYMNZKApsnIVqeb2ZWFDFi4zdHavd/jaifE0Da87qoAeollZeQy6zhkdDnGQWuDWPa9NeAOKpTVh
//#TZFFma+Il4T4TXO1bRF6pHn1mEmEu4Wp1LgStzr303a/zACq4udsLlrFyDFla1kCNhkojpornbpCa3ThrLCv1FJ/VVM/n7pYI47P
//#7muzWFneMcJT4aS5VmzTGdH60xAPBhe70fBNscDTuqugfDTM2xrn/pH5AucKutSGRYUvnt7E7ZyZrGdWwtsNxGNoZYpikbpgVjm6
//#Bawb7xpKfmdhjlc9MHnxMfS6I8oy8Hs5V1rxLUF/TQP7IY5X6dV+V++RVE27kapG2fUxjKMBobuyZwtnzcLgk/U6KbE3aPGz4U66
//#0CC1ceUo5b+5jvXh62mfZJ2X4bZK942behafHUJJDS8Sidpft0+VZ38Qn/qFOU7MfPHOUbLZLP+fO24p+OD0mxz1vM1ZZ9/U4VZY
//#i+lHaJ6MfqJx21dFTaG52buyFCJWjPZPjxDLDXG9Zk7NZD1TpmL0oNRtDgnxhG1/Rma4NZnNmDDj7Ifi38WOjZWL3PnIq8ZWJ2MN
//#6HtOkgS7eEq0cG/LDnfEKX+QmrUatByrsZYBirsaxH7mdbWXUU5bpUnk+wK2yxTOMyYX8L3jPc3R/x0vY8V6lTHbPhqRksRC//xy
//#Obw3AXT6NAHXvwG2NIi+bLtgnNK2tTfD+OMDN0iu8hJpIXNRjnI1Zw/R7DZhw3SgCQ6FBiVYf2hEYuzG6gX3y/Lftg6tXG2GoVzF
//#bLUftLUHswbEqj0Ubdf+ZoqqL3MrGM3KyWVSdLnsfFum6ZCIqipNTdfwBKyHAzjUmu6GeEV8ko+ujyvX7VZ26uXd7yI0rMAm1HXp
//#15FOD3Tm6lLzYn3AQCTvQRslsbnXQHVZJ4ALu6C1jrzAkqtnMJOOMRvLslfN7aWszGeu0uF6h8qc8ym1ZwHMcj/P8BbiH/QIW0U3
//#MCgeOr9UoUWUR0C0Iz+HUOLBotTwdoMzMaWarYu6Cyilbx4XubiKLNi2MTbZGeJN9wNZ3yQ036rm6isOB9X6FOTd8PNu5kiEMunQ
//#qFkUOrLyrFIv5ZyRyBvUNbVxVH9m4nguTAwo1FUXmA8gOuP3M2F3miOkUnyP70vWDgzFP2nyJY+iX76O8sWa1i6KTtoV3tKvYTRB
//#a003hX+rx/G0XG7jpzbezWZ9kTHZ4O9Rf3zHWHOBGZG/ApETKxW3uY8VeIXRLaMLI4+81kOmeGxzEV9aUiQC6vmbPl8p16Er+9Lj
//#yxCsEE2FhPtCCpFdvD4WWAlKouFjlUCAExlRgA8AeYCL2r8thGaosfDzruOw/WBZ/LTUe8Lv0/IFabdDL0fAz3pKu44vQxMeM1xZ
//#dHNJHNKG4zZHhUQ75tzynd6UGuvY0vYhVbTFJtYN9/3/TGj4Z1VtfqX+6NVRU4sYYyiH3AwqHk0sobGua9MeW1aE7VoYTNJsR6/L
//#AhofBkXsg2XlzmxArYop0eEkzNMi/lEVvEtQb8ib+OKGpWASWgZh2tBuXJD4iyKAwKVFyCoPr/VKQIGBoGaPVnYaIljDzAdhhyLy
//#PGBM8caFGOsLsCxr7PPVlYWK9AmzWrQCSh66ZBwrlg0PdG+isAhzkHkuOxzJhrdEoVew69WFqL3B21pFgKwpCYRP32wrazqLIgh1
//#dgJ/a2lMHJZSKqlis2aZPYTS5KFJcrwYrZLut+YgUNBOmNNh6HZLpDqL54q/WcsR5pxIAQlGPgwWZR12vQQNzmIzLvaDMhuG/EMJ
//#Pt1jLXIEyrKFHLiMLP0fYpQHw8zozVmJjcM7eaYZPdUlZki//A4jyW8OSUuPi9OP8UaB5jSRWyLA3Sa4T6U1qh5prKSpZ9Oe/Yz0
//#H23z9QfwydcpI1vg/pub63texWYjvNYwut2iGf7nTZVxMS2/UA5Xq8+MRA//6gd3nC5E9zBU2/F62f45Q1P4/JoOcFTlqCgSqskT
//#c8/BYaifOyh2VMCSmcmYrrsSea3fE1IH9U4rV+G+spU/23WtL2bGsPr6XzGzMCLQTlkl7W6g/km9xQyUdJw/9f3Aixs9xwBkOm4t
//#zEpauwV6kqV94nd+xPuGVW1YwkruOAB3XXZ7DZXyzf7ITGs31Xjbl2sGXYl0xkOW2ghdhvDAt0wjNUM2v9P3bgjNft7m3U6qdm/x
//#am4BJVnrD8uf1AsF//qn/U/BStrDk/S98KXmwTf0TTf9LSefT2NE6x6/8Ojz8CwEr2TfQI3LZ/LqeVjHS5vP/s+GSjueWSOG64hY
//#Sm8EbJVfikGnDvSqwPElf4mN6sdFGmCj+JjEmuj3z+7Z5nMonOcKnl9TR1se5xBDu4ldnIMygeLK3dYQk4Z+6+2K41iHFjsib6zA
//#y33USYQPuZ4eZaDp8bJzDJBrwjQXmcEF3MOH+C1ganDjRMQT2Pqhg2JHhJGLK6RGRLTvRcZfzgc0ZRy+wqUDKMN+HePSwj12YlyZ
//#3bjX9EYQ0m9oWiPHO39Aq8iadogZVMVRO4n0IsjZjifzqzUU6I4s0jtQKVb5iq2VT4s1dnHbqnw0n1Me7FlZuDVdcj3k6aXXxI6i
//#K9HLqFl9a6cigdRU5o0vqFZwlEgL7ZGQI6X21vYYd5p8Wk+DiA7IpjYwpA09v7D1z+NYtlicsT9sQRB+Qq3m3X3OkweAyTPQ+5EZ
//#hAdgyzxD7ATWSZxP7Pk1w6IHLKEW6lnkzeeyL/zSHMCURTeKUYSl2DRAWKksMvnvKtX5Zq9MxO9ka7F3HWtNJGD786VA92XKGKcl
//#OKdYe/hKX+aBvEhF8UZi9PxXeMCvynf5+ezn/Zrvu0kaiIyn4c259/E26m822uEQ6DXIlXC5IeJZ9PvigyoCukgiWLQ7yEWz+0Kx
//#PTfMv4/WMyMnBIWBU4IKTvUiTYMv/3x6jinKTeaB2DDK7I5j1kWUq7NoYXzjmFhSEWTgJG6SttlTZbwSG3katMVkZ5uJzHZTlI1G
//#A9b0H2/ZIl2TNhZTtIRIy2dWH/hIYjVqmO6EnaJVwzTgyuEwgYH/LEOrtsgrUDcO6hC30RrDIb2y/dsRzm8YVWGhtZpBU7z2TFmt
//#OulXbPyi/SZEUfcmIv5p9Nvq7JylrYrVd7B0B9AqsCklgaCmipYTrGSX6onHGIc1S4Tc6O2PosMK4HOVLuzagUs+IZeVrsykRxBL
