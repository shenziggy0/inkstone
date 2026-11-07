/**
 * Emoji shortcodes, shared by the `:` autocomplete and the picker dialog.
 * Typora accepts GitHub-style `:name:` codes and writes the Unicode glyph
 * into the source, which is what `apply` does here.
 */
export const EMOJI = [
  [':grinning:', '😀'], [':smile:', '😄'], [':laughing:', '😆'], [':blush:', '😊'],
  [':wink:', '😉'], [':heart_eyes:', '😍'], [':thinking:', '🤔'], [':sunglasses:', '😎'],
  [':cry:', '😢'], [':sob:', '😭'], [':angry:', '😠'], [':joy:', '😂'],
  [':thumbsup:', '👍'], [':thumbsdown:', '👎'], [':clap:', '👏'], [':ok_hand:', '👌'],
  [':pray:', '🙏'], [':muscle:', '💪'], [':wave:', '👋'], [':handshake:', '🤝'],
  [':heart:', '❤️'], [':broken_heart:', '💔'], [':sparkles:', '✨'], [':fire:', '🔥'],
  [':star:', '⭐'], [':star2:', '🌟'], [':zap:', '⚡'], [':boom:', '💥'],
  [':tada:', '🎉'], [':confetti_ball:', '🎊'], [':gift:', '🎁'], [':trophy:', '🏆'],
  [':rocket:', '🚀'], [':airplane:', '✈️'], [':car:', '🚗'], [':ship:', '🚢'],
  [':computer:', '💻'], [':iphone:', '📱'], [':keyboard:', '⌨️'], [':bug:', '🐛'],
  [':gear:', '⚙️'], [':wrench:', '🔧'], [':hammer:', '🔨'], [':bulb:', '💡'],
  [':mag:', '🔍'], [':lock:', '🔒'], [':unlock:', '🔓'], [':key:', '🔑'],
  [':book:', '📖'], [':books:', '📚'], [':memo:', '📝'], [':pencil:', '✏️'],
  [':pushpin:', '📌'], [':paperclip:', '📎'], [':file_folder:', '📁'], [':date:', '📅'],
  [':chart:', '📈'], [':bar_chart:', '📊'], [':white_check_mark:', '✅'], [':x:', '❌'],
  [':warning:', '⚠️'], [':no_entry:', '⛔'], [':question:', '❓'], [':exclamation:', '❗'],
  [':+1:', '👍'], [':-1:', '👎'], [':eyes:', '👀'], [':bulb:', '💡'],
  [':coffee:', '☕'], [':beer:', '🍺'], [':pizza:', '🍕'], [':apple:', '🍎'],
  [':sun:', '☀️'], [':moon:', '🌙'], [':cloud:', '☁️'], [':rainbow:', '🌈'],
  [':cat:', '🐱'], [':dog:', '🐶'], [':unicorn:', '🦄'], [':whale:', '🐳'],
  [':checkered_flag:', '🏁'], [':package:', '📦'], [':link:', '🔗'], [':email:', '✉️']
];

const options = EMOJI.map(([label, glyph]) => ({ label, detail: glyph, apply: glyph, type: 'text' }));

/**
 * `:smi` → suggest `:smile:`; accepting writes the glyph itself.
 * A colon in the middle of a word (`a:b`) is ignored.
 */
export function emojiCompletion(context) {
  const match = context.matchBefore(/:[A-Za-z0-9_+-]*:?/);
  if (!match) return null;
  const before = context.state.doc.sliceString(Math.max(0, match.from - 1), match.from);
  if (before && /[\p{L}\p{N}]/u.test(before)) return null;
  if (match.text.length < 2 && !context.explicit) return null;
  return { from: match.from, options, validFor: /^:[A-Za-z0-9_+-]*:?$/ };
}
