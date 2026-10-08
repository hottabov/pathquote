import { describe, it, expect } from "vitest";
import {
  ABBREVIATION_MAX_LETTERS,
  normalisePlaceName,
  normaliseStateName,
} from "../src/lib/place-name";

describe("normalisePlaceName", () => {
  describe("the shapes ACT! left behind", () => {
    it.each([
      // Not capitalised.
      ["st paul", "St Paul"],
      ["gleason", "Gleason"],
      ["new york", "New York"],
      ["los angeles", "Los Angeles"],
      // Reversed case: caps lock held down while shift-typing.
      ["rEVERS cASE", "Revers Case"],
      ["nEW yORK", "New York"],
      ["tOKYO", "Tokyo"],
      // Shouted.
      ["ST PAUL", "St Paul"],
      ["NEW YORK", "New York"],
      ["LOS ANGELES", "Los Angeles"],
      ["GLEASON", "Gleason"],
      // Some words right and some wrong in the same value.
      ["Los angeles", "Los Angeles"],
      ["new York", "New York"],
      ["Los ANGELES", "Los Angeles"],
    ])("%j -> %j", (input, expected) => {
      expect(normalisePlaceName(input)).toBe(expected);
    });

    it("fixes the case of 'bELL gARDDENS' and leaves its spelling alone", () => {
      // "Garddens" is a misspelling of "Gardens". Case is mechanical; spelling is
      // a guess about what somebody meant, and a guessed client address is worse
      // than one that is visibly odd for a person to correct.
      expect(normalisePlaceName("bELL gARDDENS")).toBe("Bell Garddens");
    });

    it("never changes which letters are there, whatever it does to their case", () => {
      const samples = [
        "bELL gARDDENS",
        "rEVERS cASE",
        "ST PAUL",
        "mcdonald",
        "o'fallon",
        "STOKE-ON-TRENT",
        "ZÜRICH",
        "straße",
        "RIO DE JANEIRO",
        "coeur d'alene",
      ];
      const letters = (text: string) => text.replace(/[^\p{L}]/gu, "").toLowerCase();
      for (const sample of samples) {
        expect(letters(normalisePlaceName(sample)!)).toBe(letters(sample));
      }
    });
  });

  describe("Mc and Mac", () => {
    it.each([
      ["mcdonald", "McDonald"],
      ["MCDONALD", "McDonald"],
      ["Mcdonald", "McDonald"],
      ["mcDonald", "McDonald"],
      ["mcallen", "McAllen"],
      ["MCKINNEY", "McKinney"],
      ["mclean", "McLean"],
      ["mcminnville", "McMinnville"],
      ["west mcdonald", "West McDonald"],
      ["mcdonald-smith", "McDonald-Smith"],
    ])("%j -> %j", (input, expected) => {
      expect(normalisePlaceName(input)).toBe(expected);
    });

    it("leaves a correct McDonald alone", () => {
      expect(normalisePlaceName("McDonald")).toBe("McDonald");
      expect(normalisePlaceName("McAllen")).toBe("McAllen");
    });

    it("does not touch a bare Mc", () => {
      expect(normalisePlaceName("mc")).toBe("Mc");
      expect(normalisePlaceName("Mc")).toBe("Mc");
    });

    it("does NOT put a capital after Mac, because Mac is usually not a prefix", () => {
      // Macon, Mackay, Macau, Maclean, Macarthur, Machias: a rule that capitalised
      // after "Mac" would be wrong for most of them.
      expect(normalisePlaceName("macon")).toBe("Macon");
      expect(normalisePlaceName("MACKAY")).toBe("Mackay");
      expect(normalisePlaceName("machias")).toBe("Machias");
      expect(normalisePlaceName("macau")).toBe("Macau");
    });

    it("keeps a Mac name that was typed correctly", () => {
      expect(normalisePlaceName("MacArthur")).toBe("MacArthur");
      expect(normalisePlaceName("MacGregor")).toBe("MacGregor");
    });
  });

  describe("apostrophes", () => {
    it.each([
      ["o'fallon", "O'Fallon"],
      ["O'FALLON", "O'Fallon"],
      ["O'Fallon", "O'Fallon"],
      ["o’fallon", "O’Fallon"],
      ["o'brien", "O'Brien"],
      ["n'djamena", "N'Djamena"],
      ["m'sila", "M'Sila"],
      // Elision: the d / l stays small unless it opens the name.
      ["coeur d'alene", "Coeur d'Alene"],
      ["COEUR D'ALENE", "Coeur d'Alene"],
      ["val-d'or", "Val-d'Or"],
      ["l'aquila", "L'Aquila"],
      ["L'AQUILA", "L'Aquila"],
      ["d'iberville", "D'Iberville"],
      // Possessives and glottal stops: what follows stays small.
      ["land's end", "Land's End"],
      ["LAND'S END", "Land's End"],
      ["bishop's stortford", "Bishop's Stortford"],
      ["st john's", "St John's"],
      ["xi'an", "Xi'an"],
      ["XI'AN", "Xi'an"],
      ["ma'ale adumim", "Ma'ale Adumim"],
      // A leading Dutch article.
      ["'s-hertogenbosch", "'s-Hertogenbosch"],
      ["'t harde", "'t Harde"],
    ])("%j -> %j", (input, expected) => {
      expect(normalisePlaceName(input)).toBe(expected);
    });
  });

  describe("hyphenated names", () => {
    it.each([
      ["baden-baden", "Baden-Baden"],
      ["BADEN-BADEN", "Baden-Baden"],
      ["winston-salem", "Winston-Salem"],
      ["wilkes-barre", "Wilkes-Barre"],
      ["garmisch-partenkirchen", "Garmisch-Partenkirchen"],
      ["baden-württemberg", "Baden-Württemberg"],
      ["nordrhein-westfalen", "Nordrhein-Westfalen"],
    ])("capitalises each part: %j -> %j", (input, expected) => {
      expect(normalisePlaceName(input)).toBe(expected);
    });

    it.each([
      ["stoke-on-trent", "Stoke-on-Trent"],
      ["STOKE-ON-TRENT", "Stoke-on-Trent"],
      ["stratford-upon-avon", "Stratford-upon-Avon"],
      ["newcastle-under-lyme", "Newcastle-under-Lyme"],
      ["southend-on-sea", "Southend-on-Sea"],
      ["saint-germain-en-laye", "Saint-Germain-en-Laye"],
      ["boulogne-sur-mer", "Boulogne-sur-Mer"],
      ["chester-le-street", "Chester-le-Street"],
      ["aix-les-bains", "Aix-les-Bains"],
      ["port-au-prince", "Port-au-Prince"],
      ["pont-à-mousson", "Pont-à-Mousson"],
      ["wells-next-the-sea", "Wells-next-the-Sea"],
      ["ashton-in-makerfield", "Ashton-in-Makerfield"],
      ["nord-pas-de-calais", "Nord-Pas-de-Calais"],
    ])("keeps the joining words small: %j -> %j", (input, expected) => {
      expect(normalisePlaceName(input)).toBe(expected);
    });

    it("corrects a joining word somebody capitalised inside a hyphenated name", () => {
      // What a naive title-caser produces, and so what ends up stored.
      expect(normalisePlaceName("Stoke-On-Trent")).toBe("Stoke-on-Trent");
      expect(normalisePlaceName("Stratford-Upon-Avon")).toBe("Stratford-upon-Avon");
    });

    it("capitalises a joining word that opens the name", () => {
      expect(normalisePlaceName("on-trent")).toBe("On-Trent");
      expect(normalisePlaceName("le-mans")).toBe("Le-Mans");
    });

    it("keeps a joining word that leads the name capitalised even after a space", () => {
      expect(normalisePlaceName("le mans")).toBe("Le Mans");
      expect(normalisePlaceName("de pere")).toBe("De Pere");
      expect(normalisePlaceName("la crosse")).toBe("La Crosse");
    });
  });

  describe("joining words between spaces", () => {
    it.each([
      ["rio de janeiro", "Rio de Janeiro"],
      ["RIO DE JANEIRO", "Rio de Janeiro"],
      ["frankfurt am main", "Frankfurt am Main"],
      ["FRANKFURT AN DER ODER", "Frankfurt an der Oder"],
      ["rothenburg ob der tauber", "Rothenburg ob der Tauber"],
      ["newcastle upon tyne", "Newcastle upon Tyne"],
      ["isle of wight", "Isle of Wight"],
      ["district of columbia", "District of Columbia"],
      ["fond du lac", "Fond du Lac"],
      ["prairie du chien", "Prairie du Chien"],
      ["reggio di calabria", "Reggio di Calabria"],
      ["santa cruz do sul", "Santa Cruz do Sul"],
      ["playa del carmen", "Playa del Carmen"],
      ["trinidad and tobago", "Trinidad and Tobago"],
      ["newfoundland and labrador", "Newfoundland and Labrador"],
      ["bad homburg vor der höhe", "Bad Homburg vor der Höhe"],
    ])("%j -> %j", (input, expected) => {
      expect(normalisePlaceName(input)).toBe(expected);
    });

    it("leaves out the words that are too often part of a real name", () => {
      // des (West Des Moines), la / le / les (Port La Vaca), van (Van Nuys).
      expect(normalisePlaceName("west des moines")).toBe("West Des Moines");
      expect(normalisePlaceName("WEST DES MOINES")).toBe("West Des Moines");
      expect(normalisePlaceName("port la vaca")).toBe("Port La Vaca");
      expect(normalisePlaceName("van nuys")).toBe("Van Nuys");
      expect(normalisePlaceName("north las vegas")).toBe("North Las Vegas");
    });

    it("does not lower-case a joining word that is the last word", () => {
      // "IN" at the end is Indiana, not a preposition.
      expect(normalisePlaceName("FORT WAYNE IN")).toBe("Fort Wayne In");
      expect(normalisePlaceName("hamilton on")).toBe("Hamilton On");
    });

    it("does not touch a joining word somebody already capitalised between spaces", () => {
      // "West De Pere" is a real place; this rule cannot tell it from "Rio De Janeiro".
      expect(normalisePlaceName("West De Pere")).toBe("West De Pere");
      expect(normalisePlaceName("Rio De Janeiro")).toBe("Rio De Janeiro");
    });
  });

  describe("values that are already right are left exactly as they are", () => {
    const correct = [
      "Atlanta",
      "St Paul",
      "St. Louis",
      "Gleason",
      "McDonald",
      "DeKalb",
      "LaGrange",
      "MacArthur",
      "O'Fallon",
      "Coeur d'Alene",
      "Land's End",
      "Stoke-on-Trent",
      "Baden-Baden",
      "Frankfurt am Main",
      "Rio de Janeiro",
      "Newcastle upon Tyne",
      "Isle of Wight",
      "West Des Moines",
      "Washington DC",
      "Zürich",
      "Östersund",
      "Straße",
      "Île-de-France",
      "NYC",
      "LA",
      "USA",
      "N.Y.C.",
      "Winston-Salem",
      "'s-Hertogenbosch",
      "Xi'an",
      "北京",
      "東京",
      "Москва",
      "?",
      "12345",
    ];

    it.each(correct)("%j is returned as it was", (value) => {
      expect(normalisePlaceName(value)).toBe(value);
    });

    it("is idempotent for every shape in this file", () => {
      const inputs = [
        ...correct,
        "st paul",
        "bELL gARDDENS",
        "rEVERS cASE",
        "ST PAUL",
        "mcdonald",
        "o'fallon",
        "stoke-on-trent",
        "STOKE-ON-TRENT",
        "  new   york  ",
        "WASHINGTON DC",
        "FORT WAYNE IN",
        "s'IN-'é’3)s",
        "COEUR D'ALENE",
        "İSTANBUL",
        "STRASSE",
      ];
      for (const input of inputs) {
        const once = normalisePlaceName(input);
        expect(normalisePlaceName(once)).toBe(once);
      }
    });

    it("is idempotent over a few thousand generated values", () => {
      // A small linear congruential generator, so the same values are tried on
      // every run and a failure can be reproduced from the message.
      let seed = 20260928;
      const next = () => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed / 2 ** 32;
      };
      const words = [
        "st", "ST", "St", "paul", "PAUL", "bELL", "gARD", "mc", "MC", "mcdonald",
        "McDonald", "o", "O", "d", "D", "l", "de", "DE", "on", "ON", "in", "IN", "am",
        "of", "dc", "DC", "la", "LA", "s", "t", "NYC", "ab", "AB", "a", "A", "Xy",
        "北京", "москва", "МОСКВА", "ß", "İ", "é", "É", "3", "12", "uk", "UK", "des",
        "van", "mac", "MAC", "macon",
      ];
      const separators = [" ", "  ", "-", "'", "’", ".", ", ", "(", ")", "/", " - ", "-'", "' "];
      const pick = <T,>(list: T[]) => list[Math.floor(next() * list.length)];
      const letters = (text: string) =>
        text.replace(/[^\p{L}\p{M}]/gu, "").normalize("NFC").toLowerCase();

      for (let n = 0; n < 4000; n += 1) {
        let input = "";
        const count = 1 + Math.floor(next() * 5);
        for (let i = 0; i < count; i += 1) {
          input += pick(words);
          if (i < count - 1) input += pick(separators);
        }
        const once = normalisePlaceName(input);
        expect(normalisePlaceName(once), `idempotence for ${JSON.stringify(input)}`).toBe(once);
        if (once !== null) {
          expect(letters(once), `letters kept for ${JSON.stringify(input)}`).toBe(letters(input));
        }
      }
    });
  });

  describe("short all-capitals values are abbreviations, not shouting", () => {
    it("pins the threshold", () => {
      expect(ABBREVIATION_MAX_LETTERS).toBe(3);
    });

    it.each([
      ["NYC", "NYC"],
      ["LA", "LA"],
      ["DC", "DC"],
      ["USA", "USA"],
      ["UAE", "UAE"],
      ["KL", "KL"],
      ["N.Y.C.", "N.Y.C."],
      ["U.S.A.", "U.S.A."],
    ])("%j stays %j", (input, expected) => {
      expect(normalisePlaceName(input)).toBe(expected);
    });

    it("stops being an abbreviation at four letters", () => {
      expect(normalisePlaceName("ROME")).toBe("Rome");
      expect(normalisePlaceName("LYON")).toBe("Lyon");
      expect(normalisePlaceName("OSLO")).toBe("Oslo");
      expect(normalisePlaceName("PERTH")).toBe("Perth");
      expect(normalisePlaceName("ABCD")).toBe("Abcd");
    });

    it("stops being an abbreviation when it has a space, however short", () => {
      expect(normalisePlaceName("ST PAUL")).toBe("St Paul");
      expect(normalisePlaceName("EL PASO")).toBe("El Paso");
      expect(normalisePlaceName("AB CD")).toBe("Ab Cd");
    });

    it("only applies to capitals: the same letters in lower case are a word", () => {
      expect(normalisePlaceName("nyc")).toBe("Nyc");
      expect(normalisePlaceName("la")).toBe("La");
    });

    it("is the known cost: a three-letter town in capitals is left in capitals", () => {
      // ULM, RIO, GAP, ELY. Unchanged rather than damaged; the repair script
      // lists every such value so a person can look.
      expect(normalisePlaceName("ULM")).toBe("ULM");
      expect(normalisePlaceName("RIO")).toBe("RIO");
    });

    it("keeps a known initialism in capitals inside a longer name", () => {
      expect(normalisePlaceName("WASHINGTON DC")).toBe("Washington DC");
      expect(normalisePlaceName("washington dc")).toBe("Washington DC");
      expect(normalisePlaceName("Washington DC")).toBe("Washington DC");
      expect(normalisePlaceName("DUBAI UAE")).toBe("Dubai UAE");
      expect(normalisePlaceName("london uk")).toBe("London UK");
    });

    it("keeps a one- or two-letter capital inside a mixed-case value", () => {
      // Nothing in the value says it is shouting, so "ST" may be an abbreviation.
      expect(normalisePlaceName("ST Louis")).toBe("ST Louis");
      expect(normalisePlaceName("Port ST Lucie")).toBe("Port ST Lucie");
    });

    it("re-cases a three-letter capital word inside a mixed-case value", () => {
      expect(normalisePlaceName("NEW york")).toBe("New York");
      expect(normalisePlaceName("Los ANGELES")).toBe("Los Angeles");
    });
  });

  describe("whitespace", () => {
    it("collapses runs of whitespace and trims", () => {
      expect(normalisePlaceName("  new   york  ")).toBe("New York");
      expect(normalisePlaceName("St\tPaul")).toBe("St Paul");
      expect(normalisePlaceName("St Paul")).toBe("St Paul");
      expect(normalisePlaceName("Hamburg\r\n")).toBe("Hamburg");
      expect(normalisePlaceName("a\n\nb")).toBe("A B");
    });

    it("trims a value that is otherwise right", () => {
      expect(normalisePlaceName("  Atlanta ")).toBe("Atlanta");
    });

    it.each([[""], ["  "], ["\t"], ["\r\n"], [" "]])("%j is null", (value) => {
      expect(normalisePlaceName(value)).toBeNull();
    });

    it.each([[null], [undefined]])("%s is null", (value) => {
      expect(normalisePlaceName(value)).toBeNull();
    });

    it("is null for something that is not a string at all", () => {
      expect(normalisePlaceName(42 as unknown as string)).toBeNull();
      expect(normalisePlaceName({} as unknown as string)).toBeNull();
    });
  });

  describe("scripts other than Latin pass through unharmed", () => {
    it.each([
      // Chinese, Japanese, Korean: no case to fix.
      ["北京", "北京"],
      ["上海市", "上海市"],
      ["東京", "東京"],
      ["とうきょう", "とうきょう"],
      ["トウキョウ", "トウキョウ"],
      ["서울", "서울"],
      // Cyrillic, Greek, Georgian, Arabic, Hebrew, Thai, Devanagari: left as typed.
      // Capitalising is a Latin idea; Georgian has no title case and Greek has a
      // final sigma that depends on context.
      ["Москва", "Москва"],
      ["москва", "москва"],
      ["МОСКВА", "МОСКВА"],
      ["Київ", "Київ"],
      ["Αθήνα", "Αθήνα"],
      ["ΑΘΗΝΑΣ", "ΑΘΗΝΑΣ"],
      ["თბილისი", "თბილისი"],
      ["القاهرة", "القاهرة"],
      ["תל אביב", "תל אביב"],
      ["กรุงเทพมหานคร", "กรุงเทพมหานคร"],
      ["नई दिल्ली", "नई दिल्ली"],
    ])("%j is untouched", (input, expected) => {
      expect(normalisePlaceName(input)).toBe(expected);
    });

    it("re-cases the Latin words next to them and not the others", () => {
      expect(normalisePlaceName("beijing 北京")).toBe("Beijing 北京");
      expect(normalisePlaceName("BEIJING 北京")).toBe("Beijing 北京");
      expect(normalisePlaceName("北京 (beijing)")).toBe("北京 (Beijing)");
      expect(normalisePlaceName("москва moscow")).toBe("москва Moscow");
      expect(normalisePlaceName("MOSCOW МОСКВА")).toBe("Moscow МОСКВА");
    });

    it("leaves a word alone when Latin and other letters are stuck together", () => {
      // A Cyrillic letter in the middle of a word makes it not a Latin word.
      expect(normalisePlaceName("ёlka")).toBe("ёlka");
      expect(normalisePlaceName("Mосква")).toBe("Mосква"); // Latin M + Cyrillic
    });

    it("still collapses whitespace around them", () => {
      expect(normalisePlaceName("  北京   ")).toBe("北京");
      expect(normalisePlaceName("Москва \t Россия")).toBe("Москва Россия");
    });
  });

  describe("accents and special letters", () => {
    it.each([
      ["zürich", "Zürich"],
      ["ZÜRICH", "Zürich"],
      ["ÖSTERSUND", "Östersund"],
      ["île-de-france", "Île-de-France"],
      ["ÎLE-DE-FRANCE", "Île-de-France"],
      ["chalon-sur-saône", "Chalon-sur-Saône"],
      ["são paulo", "São Paulo"],
      ["SÃO PAULO", "São Paulo"],
      ["kraków", "Kraków"],
      ["ŁÓDŹ", "Łódź"],
      ["straße", "Straße"],
    ])("%j -> %j", (input, expected) => {
      expect(normalisePlaceName(input)).toBe(expected);
    });

    it("never turns a letter into two", () => {
      // ß upper-cases to SS; a name that opens with one keeps its own letter.
      expect(normalisePlaceName("ßtadt")).toBe("ßtadt");
    });

    it("does not lose a dotted capital I", () => {
      expect(normalisePlaceName("İSTANBUL")).toBe("İstanbul");
    });

    it("composes and decomposes accents the same way", () => {
      const decomposed = "ZÜRICH"; // U + combining diaeresis
      const result = normalisePlaceName(decomposed)!;
      expect(result.normalize("NFC")).toBe("Zürich");
    });
  });

  describe("digits and punctuation", () => {
    it("leaves letters stuck to a number as they were typed", () => {
      // "3rd" is an ordinal, not a word to capitalise; the words around it are.
      expect(normalisePlaceName("3rd street")).toBe("3rd Street");
      expect(normalisePlaceName("21st")).toBe("21st");
      expect(normalisePlaceName("5TH AVE")).toBe("5TH Ave");
    });

    it("capitalises after the usual punctuation", () => {
      expect(normalisePlaceName("paris, france")).toBe("Paris, France");
      expect(normalisePlaceName("st. louis")).toBe("St. Louis");
      expect(normalisePlaceName("ft. worth")).toBe("Ft. Worth");
      expect(normalisePlaceName("hamburg/altona")).toBe("Hamburg/Altona");
      expect(normalisePlaceName("(paris)")).toBe("(Paris)");
    });

    it("returns a value with no letters as it was", () => {
      expect(normalisePlaceName("???")).toBe("???");
      expect(normalisePlaceName("-")).toBe("-");
      expect(normalisePlaceName("12345")).toBe("12345");
    });
  });
});

describe("normaliseStateName", () => {
  describe("two letters is a code", () => {
    it.each([
      ["ca", "CA"],
      ["CA", "CA"],
      ["Ca", "CA"],
      ["cA", "CA"],
      ["tx", "TX"],
      ["on", "ON"],
      ["wa", "WA"],
      ["nt", "NT"],
      ["sa", "SA"],
    ])("%j -> %j", (input, expected) => {
      expect(normaliseStateName(input)).toBe(expected);
    });

    it("trims first", () => {
      expect(normaliseStateName("  ca ")).toBe("CA");
    });

    it("does not treat two letters of another script as a code", () => {
      expect(normaliseStateName("北京")).toBe("北京");
      expect(normaliseStateName("мо")).toBe("мо");
    });
  });

  describe("three letters: the Australian codes, and only those", () => {
    it.each([
      ["nsw", "NSW"],
      ["NSW", "NSW"],
      ["Nsw", "NSW"],
      ["qld", "QLD"],
      ["Qld", "QLD"],
      ["vic", "VIC"],
      ["Vic", "VIC"],
      ["tas", "TAS"],
      ["act", "ACT"],
    ])("%j -> %j", (input, expected) => {
      expect(normaliseStateName(input)).toBe(expected);
    });

    it("does not guess a code for any other three letters", () => {
      // "Two letters is a code" alone is not enough for Australia, but "three
      // letters is a code" would be wrong the other way: Fla, Ont, Tex and Cal
      // are half-words. So the five are written out and nothing else is guessed.
      expect(normaliseStateName("nrw")).toBe("Nrw");
      expect(normaliseStateName("tex")).toBe("Tex");
      expect(normaliseStateName("ont")).toBe("Ont");
    });

    it("leaves a short code in capitals as the abbreviation it is", () => {
      expect(normaliseStateName("NRW")).toBe("NRW");
      expect(normaliseStateName("TEX")).toBe("TEX");
    });

    it("does not read the codes inside a longer name", () => {
      expect(normaliseStateName("Victoria")).toBe("Victoria");
      expect(normaliseStateName("tasmania")).toBe("Tasmania");
    });
  });

  describe("a name is a name", () => {
    it.each([
      ["new south wales", "New South Wales"],
      ["NEW SOUTH WALES", "New South Wales"],
      ["queensland", "Queensland"],
      ["western australia", "Western Australia"],
      ["district of columbia", "District of Columbia"],
      ["newfoundland and labrador", "Newfoundland and Labrador"],
      ["baden-württemberg", "Baden-Württemberg"],
      ["nordrhein-westfalen", "Nordrhein-Westfalen"],
      ["île-de-france", "Île-de-France"],
      ["rHONE-aLPES", "Rhone-Alpes"],
      ["texas", "Texas"],
      ["north carolina", "North Carolina"],
    ])("%j -> %j", (input, expected) => {
      expect(normaliseStateName(input)).toBe(expected);
    });

    it("leaves a correct name alone", () => {
      for (const name of ["New South Wales", "Ontario", "Baden-Württemberg", "Bayern", "CA", "NSW"]) {
        expect(normaliseStateName(name)).toBe(name);
      }
    });
  });

  describe("empty values", () => {
    it.each([[""], ["  "], ["\t"]])("%j is null", (value) => {
      expect(normaliseStateName(value)).toBeNull();
    });

    it.each([[null], [undefined]])("%s is null", (value) => {
      expect(normaliseStateName(value)).toBeNull();
    });
  });

  it("is idempotent", () => {
    for (const input of ["ca", "nsw", "Vic", "new south wales", "NEW SOUTH WALES", "nrw", "x", "北京", "  ca "]) {
      const once = normaliseStateName(input);
      expect(normaliseStateName(once)).toBe(once);
    }
  });
});
