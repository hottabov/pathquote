// A city, suburb, state or province: how it is stored and how it is printed.
//
// Pure on purpose, for the reason `website.ts` is: the ACT! import, the company
// form and the repair script all need the same rule, and a rule that lives in
// one of them is a rule the others quietly disagree with.
//
// WHY THE STORED VALUE AND NOT THE RENDERING: `city` is printed on the quote a
// client receives (src/components/sheet/sections/document-header.tsx), so
// `bELL gARDDENS` is not a cosmetic problem in a list -- it goes out in a PDF.
// ACT! is a twenty-year-old free-text system and the import brought its habits
// with it: `st paul`, `gleason`, `rEVERS cASE` (caps lock held down while
// shift-typing), and whole columns in capitals.
//
// WHAT THIS DOES NOT DO: it never touches spelling. `bELL gARDDENS` becomes
// `Bell Garddens`, not `Bell Gardens`. Case is mechanical and cannot be wrong
// about which letters are there; a spelling fix is a guess about what somebody
// meant, and a guessed client address is worse than one that is visibly odd for
// a person to correct. Every rule below changes the case of letters that are
// already present and the whitespace between them, and nothing else. The
// letters themselves -- and so everything a search matches on -- are identical
// before and after.
//
// THE RULES, in the order they matter:
//
//   * Only Latin-script words are re-cased. A run of letters containing any
//     other script (Chinese, Japanese, Cyrillic, Arabic, Georgian...) is left
//     byte-for-byte as it came. Georgian has no title case and Greek has a
//     context-dependent final sigma; "capitalise the first letter" is a Latin
//     idea, and applying it elsewhere is how a name gets mangled.
//
//   * A value already in a sensible mixed case is left exactly as it is, so
//     running the repair twice changes nothing: `McDonald`, `DeKalb`,
//     `Stoke-on-Trent`, `Frankfurt am Main` all come back untouched.
//
//   * A value with no lower-case letter is shouting -- unless it is short. See
//     ABBREVIATION_MAX_LETTERS.
//
//   * Small joining words (`on`, `de`, `am`...) stay lower-case in the middle of
//     a name. See JOINERS and HYPHEN_JOINERS.
//
//   * `Mc` is followed by a capital (`McDonald`). `Mac` is deliberately not:
//     see MC_PREFIX.

/**
 * A value of this many letters or fewer, all in capitals, with no space in it,
 * is an abbreviation and is left alone: `NYC`, `LA`, `USA`, `N.Y.C.`.
 *
 * Three, because the abbreviations that really occur in a city or region field
 * are two or three letters (`NYC`, `DFW`, `UAE`, `KL`), while a four-letter
 * capitalised word is far more likely to be a town typed in capitals than an
 * initialism (`ROME`, `LYON`, `OSLO`, `PERTH`, `DOHA`). The cost of being wrong
 * is lopsided the same way: leaving `NYC` alone loses nothing, whereas
 * "correcting" it to `Nyc` damages a value that was right. The price of the
 * threshold is a handful of genuine three-letter towns in capitals (`ULM`,
 * `RIO`, `GAP`, `ELY`) that stay in capitals -- unchanged, so nothing is
 * lost, and the repair script lists every such value for a person to look at.
 *
 * The "no space in it" half is what lets `ST PAUL` through: two words, so it
 * is a name shouted, not an abbreviation.
 */
export const ABBREVIATION_MAX_LETTERS = 3;

/**
 * Initialisms that stay in capitals wherever they appear as a word of their
 * own, because `Washington Dc` is wrong in a way `WASHINGTON DC` is not. Kept
 * short on purpose: this is not a gazetteer, only the ones a city or region
 * field is plausibly seen carrying.
 */
const INITIALISMS = new Set(["DC", "UK", "USA", "UAE"]);

/**
 * Small words that join the parts of a name and stay lower-case when they are
 * not the first word: `Rio de Janeiro`, `Prairie du Chien`, `Isle of Wight`,
 * `Frankfurt am Main`, `Newcastle upon Tyne`, `Reggio di Calabria`.
 *
 * Applied only to a word that is being re-cased anyway (`rio de janeiro`,
 * `RIO DE JANEIRO`) -- a word somebody already wrote as `De` is not touched
 * here, because `West De Pere` is a real place and this rule cannot tell it
 * from `Rio De Janeiro`. A joiner that is the LAST word is never a joiner (it
 * joins nothing): `Fort Wayne IN` must not become `Fort Wayne in`.
 *
 * Left out because they are too often a real word of a name rather than a
 * joiner: `des` (West Des Moines), `la`/`le`/`les`/`el` (Port La Vaca, Le Mans),
 * `van`/`von` (Van Nuys). Those are capitalised like any other word.
 */
const JOINERS = new Set([
  "of", "on", "upon", "under", "in", "the", "and",
  "de", "del", "du", "di", "da", "do", "dos", "das",
  "am", "an", "im", "der", "bei", "ob", "auf", "vor",
  "sur", "sous", "en",
]);

/**
 * Inside a HYPHENATED name the joiners are lower-case wherever they sit, other
 * than first: `Stoke-on-Trent`, `Stratford-upon-Avon`, `Saint-Germain-en-Laye`,
 * `Chester-le-Street`, `Port-au-Prince`. This is the choice the brief asks to
 * have stated: lower-case, and even over an existing capital, so
 * `Stoke-On-Trent` (what a naive title-caser produces, and what ends up stored
 * when somebody uses one) is corrected to `Stoke-on-Trent`.
 *
 * It can afford to be firmer than the space rule because after a hyphen these
 * words are overwhelmingly joiners; `la`, `le`, `les` and `au` join the set
 * here for that reason, where `Port La Vaca` kept them out of the other.
 */
const HYPHEN_JOINERS = new Set([
  ...JOINERS,
  "la", "le", "les", "au", "aux", "à", "lès", "lez", "next", "over", "super", "cum",
]);

// `Mc` + a lower-case run of at least three letters is `Mc` + a surname:
// McDonald, McAllen, McKinney, McLean, McMinnville. Applied after the run has
// been re-cased, and to a run that is only `Mcxxx` -- `McDonald` itself has an
// inner capital and is never matched, which is how it survives untouched.
//
// `Mac` gets NO such rule, and that is a deliberate gap in the brief's "Mc and
// Mac". `Mc` is followed by a capital in practically every place name that
// starts with it; `Mac` is not -- Macon, Mackay, Macau, Maclean, Macarthur,
// Machias, Macclesfield, Macomb. A rule that turned `macon` into `MaCon` would
// be wrong far more often than it was right. `MacArthur` and `MacGregor` typed
// correctly are safe anyway (an inner capital is never re-cased); the ones lost
// are `macarthur` -> `Macarthur` typed in lower case, which is a visible,
// harmless miss.
const MC_PREFIX = new RegExp("^Mc\\p{Ll}{3,}$", "u");

// A run of letters (any script) with its combining marks.
const LETTER_RUN = new RegExp("[\\p{L}\\p{M}]+", "gu");
// Any character that is neither a Latin letter nor a combining mark: one of
// these in a run means it is not a Latin word and is left alone.
const NOT_LATIN = new RegExp("[^\\p{Script=Latin}\\p{M}]", "u");
const DIGIT = new RegExp("\\p{N}", "u");

const isApostrophe = (char: string) => char === "'" || char === "’";
const isUpperChar = (char: string) => char !== char.toLowerCase();
const isLowerChar = (char: string) => char !== char.toUpperCase();

interface Run {
  text: string;
  start: number;
  end: number;
  latin: boolean;
}

function findRuns(text: string): Run[] {
  const runs: Run[] = [];
  for (const match of text.matchAll(LETTER_RUN)) {
    const start = match.index ?? 0;
    runs.push({
      text: match[0],
      start,
      end: start + match[0].length,
      latin: !NOT_LATIN.test(match[0]),
    });
  }
  return runs;
}

const chars = (word: string) => Array.from(word);

/**
 * Upper-case the first character, but only when that stays one character:
 * `ß` upper-cases to `SS`, which would turn a letter into two.
 */
function capitalFirst(word: string): string {
  const [first, ...rest] = chars(word);
  const upper = first.toUpperCase();
  return (chars(upper).length === 1 ? upper : first) + rest.join("");
}

/** First character upper-case, the rest lower-case. */
function capitalise(word: string): string {
  const [first, ...rest] = chars(word);
  return capitalFirst(first) + rest.join("").toLowerCase();
}

/**
 * The right case for one Latin word, ignoring where it sits in the name.
 *
 * `shouting` is whether the whole value has no lower-case letter. The cases of
 * a word that already has some lower-case in it:
 *
 *   mgr / Paul    all lower / capitalised     -> Mgr stays Paul; lower is capitalised
 *   bELL          lower first, rest capitals  -> Bell   (caps lock + shift)
 *   deKalb        lower first, then mixed     -> DeKalb  (only the first letter)
 *   McDonald      capital first, then mixed   -> left as typed
 */
function fixWord(word: string, shouting: boolean): string {
  const letters = chars(word);
  const first = letters[0];
  const rest = letters.slice(1);

  const hasLower = letters.some(isLowerChar);
  const hasUpper = letters.some(isUpperChar);
  if (!hasLower && !hasUpper) return word; // no case at all

  if (!hasUpper) {
    return INITIALISMS.has(word.toUpperCase()) ? word.toUpperCase() : capitalise(word);
  }

  if (!hasLower) {
    if (INITIALISMS.has(word)) return word;
    // In a value that has lower-case elsewhere, a capitalised word of one or
    // two letters is an initial or an abbreviation (`St`, `DC`, the `D` of
    // `Coeur D'Alene`); three or more is a shouted word. In a shouted value
    // there is no such evidence, so every word is a word: `ST PAUL` becomes
    // `St Paul`.
    if (!shouting && letters.length <= 2) return word;
    return capitalise(word);
  }

  // From here the word has both cases.
  if (isUpperChar(first)) return word; // McDonald, DeKalb, Paul: left as typed

  // `bELL`, `rEVERS`, `cASE`: lower first, nothing but capitals after it.
  if (!rest.some(isLowerChar)) return capitalise(word);
  // `deKalb`, `mcDonald`: the capital in the middle is probably meant.
  return capitalFirst(word);
}

/**
 * The shared work behind both exports: collapse whitespace, then re-case the
 * Latin words in place. Everything that is not a Latin word -- punctuation,
 * digits, other scripts -- is copied across untouched.
 */
function recase(text: string): string {
  const runs = findRuns(text);
  const latinChars = runs.filter((run) => run.latin).flatMap((run) => Array.from(run.text));
  const hasLower = latinChars.some(isLowerChar);
  const hasUpper = latinChars.some(isUpperChar);
  if (!hasLower && !hasUpper) return text;

  const shouting = !hasLower;
  const letterCount = latinChars.length;
  if (shouting && letterCount <= ABBREVIATION_MAX_LETTERS && !/\s/.test(text)) return text;

  let out = "";
  let cursor = 0;

  runs.forEach((run, index) => {
    out += text.slice(cursor, run.start);
    cursor = run.end;
    if (!run.latin) {
      out += run.text;
      return;
    }

    const before = text.slice(index === 0 ? 0 : runs[index - 1].end, run.start);
    const previous = index === 0 ? null : runs[index - 1];
    const next = index === runs.length - 1 ? null : runs[index + 1];

    // `3rd`, `21st`: letters stuck to a number are an ordinal, not a word.
    if (run.start > 0 && DIGIT.test(text[run.start - 1])) {
      out += run.text;
      return;
    }

    let word = fixWord(run.text, shouting);
    const touched = shouting || word !== run.text;

    // After an apostrophe. A ONE-letter word before it is an elision or a
    // prefix and the word after it is a name: O'Fallon, D'Alene, N'Djamena.
    // Anything else makes the apostrophe a possessive, a glottal stop or a
    // leading Dutch article, and what follows stays small: Land's End, Xi'an,
    // Ma'ale, 's-Hertogenbosch.
    const afterApostrophe = before.length === 1 && isApostrophe(before);
    const afterInitial =
      afterApostrophe && previous !== null && previous.latin && Array.from(previous.text).length === 1;
    if (afterInitial) {
      word = capitalFirst(word);
    } else if (afterApostrophe) {
      // Lower-case already needs nothing, and a mixed word is left as typed;
      // only shouting (the whole value, or this word) is brought down.
      const shouted = shouting || (!chars(run.text).some(isLowerChar) && chars(run.text).length >= 3);
      word = shouted ? run.text.toLowerCase() : run.text;
    }

    // The letter BEFORE an apostrophe that begins an elided word: the `d` of
    // `Coeur d'Alene` and `Val-d'Or`, the `l` of `Port-l'Evêque`. Small unless
    // it opens the name, and only when it is being re-cased -- `Coeur D'Alene`
    // as typed is left alone like any other mixed-case value.
    const beforeApostrophe =
      next !== null &&
      next.latin &&
      next.start === run.end + 1 &&
      isApostrophe(text[run.end]) &&
      chars(run.text).length === 1;
    if (beforeApostrophe && index > 0 && touched && /^[dl]$/i.test(run.text)) {
      word = run.text.toLowerCase();
    }

    // Joining words. Never the first word, never the last (a joiner joins the
    // word after it, and `IN` at the end is Indiana, not a preposition), and
    // never straight after an apostrophe.
    if (index > 0 && next !== null && !afterApostrophe) {
      const small = run.text.toLowerCase();
      const hyphenated = before === "-";
      if (hyphenated && HYPHEN_JOINERS.has(small)) word = small;
      else if (!hyphenated && touched && JOINERS.has(small)) word = small;
    }

    if (MC_PREFIX.test(word)) word = `Mc${word[2].toUpperCase()}${word.slice(3)}`;

    out += word;
  });

  return out + text.slice(cursor);
}

/** A city, suburb or region as it should be stored and printed. */
export function normalisePlaceName(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/g, " ").trim();
  if (text === "") return null;

  // Run to a fixed point, which is what makes this idempotent. One pass can
  // leave a value that the next pass reads differently: `s'IN-'é’3)s` is mixed
  // case on the way in, so `IN` is kept as an abbreviation, but every other
  // word is a single capital and the result has no lower-case letter at all --
  // so on the next run it would be "shouting" and `IN` would change. Running
  // the rule again until it stops moving gives the answer the second run would
  // have given, so the second run changes nothing. Each pass only ever moves a
  // word towards the form it settles in, so this ends after one or two extra
  // passes; the bound is a guard, not an expectation.
  let current = recase(text);
  for (let pass = 0; pass < 5; pass += 1) {
    const next = recase(current);
    if (next === current) break;
    current = next;
  }
  return current;
}

// Australian states and territories written with three letters. The two-letter
// rule alone catches `WA`, `SA` and `NT`, but not these, and Australia is this
// business's home market, so `nsw` is not an exotic input.
const THREE_LETTER_STATE_CODES = new Set(["NSW", "QLD", "VIC", "TAS", "ACT"]);

/**
 * A state or province. Two Latin letters are a code and are upper-cased
 * (`ca` -> `CA`, `Ns` -> `NS`). The five three-letter Australian codes are
 * upper-cased too (`nsw` -> `NSW`, `Vic` -> `VIC`).
 *
 * Two letters alone is not enough, and a general "three letters is a code" rule
 * would be wrong in the other direction: `Ohio` is not three letters but `Fla`,
 * `Ont`, `Tex` and `Cal` are abbreviations that are also half-words, and which
 * three-letter strings are codes depends on the country. So the list is the one
 * country whose three-letter codes this business meets, written out; any other
 * three-letter value follows the ordinary rule (`NRW` stays, being capitals and
 * short; `nrw` becomes `Nrw`, visibly off rather than guessed).
 *
 * Anything else is a name -- `new south wales` -> `New South Wales` -- and goes
 * through `normalisePlaceName`. A two-letter value in another script (`北京`)
 * is not a code and is left alone.
 */
export function normaliseStateName(value: string | null | undefined): string | null {
  const name = normalisePlaceName(value);
  if (name === null) return null;
  if (/^[A-Za-z]{2}$/.test(name)) return name.toUpperCase();
  if (THREE_LETTER_STATE_CODES.has(name.toUpperCase())) return name.toUpperCase();
  return name;
}
