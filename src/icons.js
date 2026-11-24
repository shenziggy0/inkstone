import panel from 'lucide-static/icons/panel-left.svg?raw';
import file from 'lucide-static/icons/file-text.svg?raw';
import folder from 'lucide-static/icons/folder.svg?raw';
import open from 'lucide-static/icons/folder-open.svg?raw';
import plus from 'lucide-static/icons/plus.svg?raw';
import search from 'lucide-static/icons/search.svg?raw';
import code from 'lucide-static/icons/code-xml.svg?raw';
import arrow from 'lucide-static/icons/share.svg?raw';
import settings from 'lucide-static/icons/settings-2.svg?raw';
import moon from 'lucide-static/icons/moon.svg?raw';
import save from 'lucide-static/icons/save.svg?raw';
import focus from 'lucide-static/icons/focus.svg?raw';
import close from 'lucide-static/icons/x.svg?raw';
import more from 'lucide-static/icons/ellipsis.svg?raw';
import image from 'lucide-static/icons/image.svg?raw';
import filePlus from 'lucide-static/icons/file-plus.svg?raw';
import folderPlus from 'lucide-static/icons/folder-plus.svg?raw';
import refresh from 'lucide-static/icons/refresh-cw.svg?raw';
import outline from 'lucide-static/icons/list-tree.svg?raw';
import articles from 'lucide-static/icons/library-big.svg?raw';
import help from 'lucide-static/icons/book-open.svg?raw';
import out from 'lucide-static/icons/arrow-up-right.svg?raw';
import pen from 'lucide-static/icons/feather.svg?raw';
import compose from 'lucide-static/icons/square-pen.svg?raw';
import command from 'lucide-static/icons/command.svg?raw';
import h1 from 'lucide-static/icons/heading-1.svg?raw';
import h2 from 'lucide-static/icons/heading-2.svg?raw';
import bold from 'lucide-static/icons/bold.svg?raw';
import italic from 'lucide-static/icons/italic.svg?raw';
import strike from 'lucide-static/icons/strikethrough.svg?raw';
import link from 'lucide-static/icons/link.svg?raw';
import table from 'lucide-static/icons/table-2.svg?raw';
import braces from 'lucide-static/icons/braces.svg?raw';
import math from 'lucide-static/icons/sigma.svg?raw';
import diagram from 'lucide-static/icons/workflow.svg?raw';
import sun from 'lucide-static/icons/sun.svg?raw';
import theme from 'lucide-static/icons/sun-moon.svg?raw';
import appearance from 'lucide-static/icons/palette.svg?raw';
import type from 'lucide-static/icons/type.svg?raw';
import chevron from 'lucide-static/icons/chevron-right.svg?raw';

const icons = {
  panel, file, folder, open, plus, search, code, arrow, settings, moon, save, focus, close,
  more, image, filePlus, folderPlus, refresh, outline, articles, help, out, pen, compose,
  command, h1, h2, bold, italic, strike, link, table, braces, math, diagram, sun, theme,
  appearance, type, chevron
};

// Keep decorative SVG whitespace out of the text of filenames and menu items.
// Vite embeds these icons in the app so they are available offline.
for (const [name, svg] of Object.entries(icons)) {
  icons[name] = svg.trim().replace(/>\s+</g, '><').replace('<svg', '<svg aria-hidden="true" focusable="false"');
}
export const icon = name => icons[name];
