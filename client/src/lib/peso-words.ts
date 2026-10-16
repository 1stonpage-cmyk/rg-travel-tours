/**
 * An amount in WORDS, beside the figures.
 *
 * Written for the driver's cash box (Week 6 Task 8, rule 3: "the amount is
 * stated in figures AND in words, so a mis-read digit cannot cost the
 * business money") and moved here by Task 13, which needs the same thing for
 * an irreversible refund confirmation. It is one function in one place
 * because two copies of a number-to-words table are two ways to spell the
 * same amount — and the entire point of the words is that they must agree
 * with the figures.
 */

const ONES = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
];

const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

const SCALES = [
  { value: 1_000_000_000, name: 'billion' },
  { value: 1_000_000, name: 'million' },
  { value: 1_000, name: 'thousand' },
] as const;

function underHundred(n: number): string {
  if (n < 20) return ONES[n]!;
  const tens = TENS[Math.floor(n / 10)]!;
  const rest = n % 10;
  return rest === 0 ? tens : `${tens}-${ONES[rest]}`;
}

function underThousand(n: number): string {
  if (n < 100) return underHundred(n);
  const hundreds = `${ONES[Math.floor(n / 100)]} hundred`;
  const rest = n % 100;
  return rest === 0 ? hundreds : `${hundreds} ${underHundred(rest)}`;
}

function wholeNumberInWords(n: number): string {
  if (n < 1000) return underThousand(n);
  for (const scale of SCALES) {
    if (n < scale.value) continue;
    const head = `${wholeNumberInWords(Math.floor(n / scale.value))} ${scale.name}`;
    const rest = n % scale.value;
    return rest === 0 ? head : `${head} ${wholeNumberInWords(rest)}`;
  }
  // Unreachable: anything >= 1000 matched a scale above.
  return underThousand(n);
}

/**
 * `450_000` centavos -> `'Four thousand five hundred pesos'`.
 *
 * **Rounded exactly the way `formatPeso` rounds**, deliberately: the words
 * exist to catch a mis-read digit in the figures beside them, so a pairing
 * that disagreed would be worse than no words at all. Every price in this
 * system is whole pesos, so the rounding never actually bites — but if it
 * ever did, both halves would move together.
 */
export function pesosInWords(centavos: number): string {
  const pesos = Math.round(centavos / 100);
  const words = wholeNumberInWords(pesos);
  return `${words.charAt(0).toUpperCase()}${words.slice(1)} ${pesos === 1 ? 'peso' : 'pesos'}`;
}
