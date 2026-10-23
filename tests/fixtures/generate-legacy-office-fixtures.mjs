#!/usr/bin/env node
/**
 * Rebuild the tiny, synthetic Office 97–2003 regression fixtures.
 *
 * No proprietary sample document is checked in. These files are authored
 * entirely from test strings through MIT-licensed doc-codec, ppt-codec and
 * @e965/xlsx writers, and contain no personal or production data.
 */
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeDocContent } from 'doc-codec';
import { writePptContent } from 'ppt-codec';
import * as XLSX from '@e965/xlsx';

const root = dirname(fileURLToPath(import.meta.url));
const paragraph = (text, extra = {}) => ({ kind: 'paragraph', runs: [{ text }], ...extra });
const cell = (text, extra = {}) => ({ blocks: [paragraph(text)], ...extra });

const word = writeDocContent({
  kind: 'wordprocessing',
  metadata: { title: 'Yayra legacy Word fixture', author: 'Arena test fixture' },
  sections: [{
    pageSize: { widthPt: 612, heightPt: 792 },
    margins: { topPt: 54, rightPt: 58, bottomPt: 54, leftPt: 58 },
    blocks: [
      paragraph('Legacy Clinical Notes', { headingLevel: 1 }),
      {
        kind: 'paragraph',
        alignment: 'center',
        spacingAfterPt: 12,
        runs: [
          { text: 'Atenolol ', bold: true, sizePt: 14, color: { r: 0.05, g: 0.25, b: 0.65 } },
          { text: 'reduces heart rate.', italic: true, sizePt: 12 }
        ]
      },
      {
        kind: 'table',
        columns: [{ widthPt: 190 }, { widthPt: 120 }],
        rows: [
          { isHeader: true, cells: [cell('Drug'), cell('Dose')] },
          { cells: [cell('Atenolol'), cell('50 mg')] },
          { cells: [cell('Metoprolol'), cell('25 mg')] }
        ]
      },
      paragraph('Monitor pulse and blood pressure.', { spacingBeforePt: 10 })
    ]
  }]
});

const shape = (name, frame, blocks, extra = {}) => ({
  name,
  frame,
  insetLeftPt: 5,
  insetTopPt: 4,
  insetRightPt: 5,
  insetBottomPt: 4,
  blocks,
  ...extra
});
const powerPoint = writePptContent({
  metadata: { title: 'Yayra legacy PowerPoint fixture', author: 'Arena test fixture' },
  slides: [
    {
      size: { widthPt: 720, heightPt: 405 },
      notes: 'Speaker note: check pulse before the next dose.',
      shapes: [
        shape('Title 1', { xPt: 54, yPt: 34, widthPt: 612, heightPt: 72 }, [{
          kind: 'paragraph',
          alignment: 'center',
          runs: [{ text: 'Legacy Pharmacology', bold: true, sizePt: 30, color: { r: 0.05, g: 0.25, b: 0.65 } }]
        }]),
        shape('Body 2', { xPt: 72, yPt: 128, widthPt: 576, heightPt: 180 }, [
          paragraph('Atenolol lowers heart rate', { spacingAfterPt: 8 }),
          paragraph('Monitor blood pressure')
        ])
      ]
    },
    {
      size: { widthPt: 720, heightPt: 405 },
      notes: 'Speaker note: doses are examples only.',
      shapes: [
        shape('Title 1', { xPt: 54, yPt: 30, widthPt: 612, heightPt: 60 }, [{
          kind: 'paragraph', alignment: 'center', runs: [{ text: 'Dose reference', bold: true, sizePt: 28 }]
        }]),
        shape('Table 2', { xPt: 100, yPt: 115, widthPt: 520, heightPt: 190 }, [{
          kind: 'table',
          columns: [{ widthPt: 260 }, { widthPt: 180 }],
          rows: [
            { isHeader: true, cells: [cell('Medicine'), cell('Example dose')] },
            { cells: [cell('Atenolol'), cell('50 mg')] },
            { cells: [cell('Metoprolol'), cell('25 mg')] }
          ]
        }])
      ]
    }
  ]
});

const workbook = XLSX.utils.book_new();
const doses = XLSX.utils.aoa_to_sheet([
  ['Medicine', 'Dose', 'Review'],
  ['Atenolol', 50, 'Check pulse'],
  ['Metoprolol', 25, 'Check pressure']
]);
doses['!cols'] = [{ wch: 20 }, { wch: 10 }, { wch: 20 }];
XLSX.utils.book_append_sheet(workbook, doses, 'Legacy doses');
const excel = new Uint8Array(XLSX.write(workbook, { type: 'array', bookType: 'xls' }));

await Promise.all([
  writeFile(join(root, 'legacy-word.doc'), word),
  writeFile(join(root, 'legacy-slides.ppt'), powerPoint),
  writeFile(join(root, 'legacy-sheet.xls'), excel)
]);
console.log(`wrote legacy fixtures: DOC ${word.byteLength} B, PPT ${powerPoint.byteLength} B, XLS ${excel.byteLength} B`);
