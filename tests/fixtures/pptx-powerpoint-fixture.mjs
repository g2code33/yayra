/**
 * Adapted from g2code33/pharmaTRACK_PERFECT_new under its MIT license;
 * retained license notice: ../../LICENSE.reference-pharmatrack.
 *
 * Fixtures that reproduce the exact structures PowerPoint (and python-pptx,
 * its default Office template) writes into real .pptx files — the parts a
 * hand-built minimal deck does not have:
 *
 *   • a title slide using `p:ph type="ctrTitle"` (not "title"),
 *   • a slide master with `p:txStyles` (44pt centred title, 32pt bulleted
 *     body with marL, 18pt other) referenced through `+mj-lt` / `+mn-lt`,
 *   • a slide layout carrying the placeholder geometry and its own lstStyle,
 *   • a theme with its own `a:clrScheme` + `a:fontScheme` and a master
 *     `p:clrMap` (tx1→dk1, bg1→lt1, …),
 *   • `a:sysClr` colours, `p:bgRef` and a full-bleed `a:blipFill` background,
 *   • cropped pictures (`a:srcRect`) framed by an `ellipse` preset,
 *   • merged table cells (gridSpan/rowSpan + hMerge/vMerge continuation cells).
 *
 * These are the cases that only show up with authentic files: without them the
 * parser renders real decks at guessed sizes, colours and fonts.
 */
import JSZip from 'jszip';

const P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const REL = (t) => `http://schemas.openxmlformats.org/officeDocument/2006/relationships/${t}`;

/** 1×1 PNG so the image relationships resolve to real media parts. */
const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
]);

const themeXml = `<?xml version="1.0"?>
<a:theme xmlns:a="${A}" name="Campus">
  <a:themeElements>
    <a:clrScheme name="Campus">
      <a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>
      <a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>
      <a:dk2><a:srgbClr val="7030A0"/></a:dk2>
      <a:lt2><a:srgbClr val="EEECE1"/></a:lt2>
      <a:accent1><a:srgbClr val="00A651"/></a:accent1>
      <a:accent2><a:srgbClr val="C0504D"/></a:accent2>
      <a:accent3><a:srgbClr val="9BBB59"/></a:accent3>
      <a:accent4><a:srgbClr val="8064A2"/></a:accent4>
      <a:accent5><a:srgbClr val="4BACC6"/></a:accent5>
      <a:accent6><a:srgbClr val="F79646"/></a:accent6>
      <a:hlink><a:srgbClr val="0000FF"/></a:hlink>
      <a:folHlink><a:srgbClr val="800080"/></a:folHlink>
    </a:clrScheme>
    <a:fontScheme name="Campus">
      <a:majorFont><a:latin typeface="Georgia"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>
      <a:minorFont><a:latin typeface="Verdana"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont>
    </a:fontScheme>
    <a:fmtScheme name="Office"><a:fillStyleLst/></a:fmtScheme>
  </a:themeElements>
</a:theme>`;

/** Master as PowerPoint writes it: clrMap, txStyles, background. */
const masterXml = (background) => `<?xml version="1.0"?>
<p:sldMaster xmlns:p="${P}" xmlns:a="${A}" xmlns:r="${R}">
  <p:cSld>
    ${background}
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr/>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="2" name="Title Placeholder 1"/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
        <p:txBody><a:bodyPr/><a:p/></p:txBody>
      </p:sp>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="3" name="Text Placeholder 2"/><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr>
        <p:txBody><a:bodyPr/><a:p/></p:txBody>
      </p:sp>
    </p:spTree>
  </p:cSld>
  <p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2"
            accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6"
            hlink="hlink" folHlink="folHlink"/>
  <p:txStyles>
    <p:titleStyle>
      <a:lvl1pPr algn="ctr"><a:buNone/><a:defRPr sz="4400"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mj-lt"/></a:defRPr></a:lvl1pPr>
    </p:titleStyle>
    <p:bodyStyle>
      <a:lvl1pPr marL="342900" indent="-342900"><a:buFont typeface="Arial"/><a:buChar char="•"/><a:defRPr sz="3200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/></a:defRPr></a:lvl1pPr>
      <a:lvl2pPr marL="742950" indent="-285750"><a:buFont typeface="Arial"/><a:buChar char="–"/><a:defRPr sz="2800"><a:latin typeface="+mn-lt"/></a:defRPr></a:lvl2pPr>
    </p:bodyStyle>
    <p:otherStyle>
      <a:lvl1pPr><a:defRPr sz="1800"><a:latin typeface="+mn-lt"/></a:defRPr></a:lvl1pPr>
    </p:otherStyle>
  </p:txStyles>
</p:sldMaster>`;

/** Layout as PowerPoint writes it: placeholder geometry + its own lstStyle. */
const layoutXml = `<?xml version="1.0"?>
<p:sldLayout xmlns:p="${P}" xmlns:a="${A}" xmlns:r="${R}" type="title">
  <p:cSld>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr/>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="2" name="Title 1"/><p:nvPr><p:ph type="ctrTitle"/></p:nvPr></p:nvSpPr>
        <p:spPr><a:xfrm><a:off x="685800" y="2130425"/><a:ext cx="7772400" cy="1470025"/></a:xfrm></p:spPr>
        <p:txBody><a:bodyPr anchor="ctr"/><a:lstStyle/><a:p/></p:txBody>
      </p:sp>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="3" name="Subtitle 2"/><p:nvPr><p:ph type="subTitle" idx="1"/></p:nvPr></p:nvSpPr>
        <p:spPr><a:xfrm><a:off x="1371600" y="3886200"/><a:ext cx="6400800" cy="1752600"/></a:xfrm></p:spPr>
        <p:txBody>
          <a:bodyPr anchor="t"/>
          <a:lstStyle>
            <a:lvl1pPr><a:defRPr sz="2400"><a:latin typeface="+mn-lt"/></a:defRPr></a:lvl1pPr>
          </a:lstStyle>
          <a:p/>
        </p:txBody>
      </p:sp>
    </p:spTree>
  </p:cSld>
</p:sldLayout>`;

const pictureXml = (rid) => `<?xml version="1.0"?>
<p:sld xmlns:p="${P}" xmlns:a="${A}" xmlns:r="${R}">
  <p:cSld><p:spTree>
    <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:nvPr/></p:nvGrpSpPr>
    <p:grpSpPr/>
    <p:sp>
      <p:nvSpPr><p:cNvPr id="2" name="Title 1"/><p:nvPr><p:ph type="ctrTitle"/></p:nvPr></p:nvSpPr>
      <p:txBody>
        <a:bodyPr/>
        <a:p><a:r><a:t>Cardiovascular Pharmacology</a:t></a:r></a:p>
      </p:txBody>
    </p:sp>
    <p:sp>
      <p:nvSpPr><p:cNvPr id="3" name="Subtitle 2"/><p:nvPr><p:ph type="subTitle" idx="1"/></p:nvPr></p:nvSpPr>
      <p:txBody>
        <a:bodyPr/>
        <a:p><a:r><a:t>Lecture 1</a:t></a:r></a:p>
      </p:txBody>
    </p:sp>
    <p:sp>
      <p:nvSpPr><p:cNvPr id="4" name="Accent bar"/><p:nvPr/></p:nvSpPr>
      <p:spPr>
        <a:xfrm><a:off x="914400" y="0"/><a:ext cx="1828800" cy="914400"/></a:xfrm>
        <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
        <a:solidFill><a:schemeClr val="accent1"/></a:solidFill>
        <a:ln w="19050"><a:solidFill><a:sysClr val="windowText" lastClr="333333"/></a:solidFill></a:ln>
      </p:spPr>
      <p:txBody><a:bodyPr/><a:p/></p:txBody>
    </p:sp>
    <p:sp>
      <p:nvSpPr><p:cNvPr id="9" name="Content Placeholder 9"/><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr>
      <p:txBody>
        <a:bodyPr/>
        <a:p><a:r><a:t>Blocks beta-1 receptors</a:t></a:r></a:p>
        <a:p><a:pPr lvl="1"/><a:r><a:t>Reduces heart rate</a:t></a:r></a:p>
      </p:txBody>
    </p:sp>
    <p:pic>
      <p:nvPicPr><p:cNvPr id="5" name="Picture 5"/><p:nvPr/></p:nvPicPr>
      <p:blipFill>
        <a:blip r:embed="${rid}"/>
        <a:srcRect l="25000" t="10000" r="10000" b="20000"/>
        <a:stretch><a:fillRect/></a:stretch>
      </p:blipFill>
      <p:spPr>
        <a:xfrm><a:off x="914400" y="1371600"/><a:ext cx="3657600" cy="2743200"/></a:xfrm>
        <a:prstGeom prst="ellipse"><a:avLst/></a:prstGeom>
      </p:spPr>
    </p:pic>
    <p:graphicFrame>
      <p:nvGraphicFramePr><p:cNvPr id="6" name="Table 6"/><p:nvPr/></p:nvGraphicFramePr>
      <p:xfrm><a:off x="914400" y="4572000"/><a:ext cx="7315200" cy="1828800"/></p:xfrm>
      <a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">
        <a:tbl>
          <a:tblGrid><a:gridCol w="1828800"/><a:gridCol w="1828800"/><a:gridCol w="1828800"/><a:gridCol w="1828800"/></a:tblGrid>
          <a:tr h="457200">
            <a:tc><a:txBody><a:p><a:r><a:rPr sz="1800" b="1"/><a:t>Drug</a:t></a:r></a:p></a:txBody><a:tcPr><a:solidFill><a:srgbClr val="DDEBF7"/></a:solidFill></a:tcPr></a:tc>
            <a:tc><a:txBody><a:p><a:r><a:rPr sz="1800" b="1"/><a:t>Dose</a:t></a:r></a:p></a:txBody><a:tcPr/></a:tc>
            <a:tc gridSpan="2"><a:txBody><a:p><a:r><a:rPr sz="1800" b="1"/><a:t>Class</a:t></a:r></a:p></a:txBody><a:tcPr/></a:tc>
            <a:tc hMerge="1"><a:txBody><a:p/></a:txBody><a:tcPr/></a:tc>
          </a:tr>
          <a:tr h="457200">
            <a:tc rowSpan="2"><a:txBody><a:p><a:r><a:rPr sz="1400"/><a:t>Atenolol</a:t></a:r></a:p></a:txBody><a:tcPr/></a:tc>
            <a:tc><a:txBody><a:p><a:r><a:rPr sz="1400"/><a:t>50 mg</a:t></a:r></a:p></a:txBody><a:tcPr/></a:tc>
            <a:tc><a:txBody><a:p><a:r><a:rPr sz="1400"/><a:t>Beta blocker</a:t></a:r></a:p></a:txBody><a:tcPr/></a:tc>
            <a:tc><a:txBody><a:p><a:r><a:rPr sz="1400"/><a:t>Cardioselective</a:t></a:r></a:p></a:txBody><a:tcPr/></a:tc>
          </a:tr>
          <a:tr h="457200">
            <a:tc vMerge="1"><a:txBody><a:p/></a:txBody><a:tcPr/></a:tc>
            <a:tc><a:txBody><a:p><a:r><a:rPr sz="1400"/><a:t>100 mg</a:t></a:r></a:p></a:txBody><a:tcPr/></a:tc>
            <a:tc><a:txBody><a:p><a:r><a:rPr sz="1400"/><a:t>Beta blocker</a:t></a:r></a:p></a:txBody><a:tcPr/></a:tc>
            <a:tc><a:txBody><a:p><a:r><a:rPr sz="1400"/><a:t>Cardioselective</a:t></a:r></a:p></a:txBody><a:tcPr/></a:tc>
          </a:tr>
        </a:tbl>
      </a:graphicData></a:graphic>
    </p:graphicFrame>
  </p:spTree></p:cSld>
</p:sld>`;

/**
 * A title slide built the way PowerPoint builds it: placeholders with no
 * geometry of their own, every visible property inherited through
 * layout → master → theme.
 */
export const buildPowerPointDeck = async (opts = {}) => {
  const zip = new JSZip();
  zip.file(
    'ppt/presentation.xml',
    `<?xml version="1.0"?>
<p:presentation xmlns:p="${P}" xmlns:a="${A}" xmlns:r="${R}">
  <p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst>
  <p:sldSz cx="12192000" cy="6858000"/>
</p:presentation>`,
  );
  zip.file(
    'ppt/_rels/presentation.xml.rels',
    `<?xml version="1.0"?>
<Relationships xmlns="${REL_NS}">
  <Relationship Id="rId1" Type="${REL('slide')}" Target="slides/slide1.xml"/>
</Relationships>`,
  );
  const bgPicture =
    opts.masterBackground === 'picture'
      ? '<p:bg><p:bgPr><a:blipFill><a:blip r:embed="rIdThemeImg"/><a:stretch><a:fillRect/></a:stretch></a:blipFill><a:effectLst/></p:bgPr></p:bg>'
      : '<p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg>';
  zip.file('ppt/slideMasters/slideMaster1.xml', masterXml(bgPicture));
  zip.file(
    'ppt/slideMasters/_rels/slideMaster1.xml.rels',
    `<?xml version="1.0"?>
<Relationships xmlns="${REL_NS}">
  <Relationship Id="rId1" Type="${REL('slideLayout')}" Target="../slideLayouts/slideLayout1.xml"/>
  <Relationship Id="rIdTheme" Type="${REL('theme')}" Target="../theme/theme1.xml"/>
  <Relationship Id="rIdThemeImg" Type="${REL('image')}" Target="../media/bg.png"/>
</Relationships>`,
  );
  zip.file('ppt/theme/theme1.xml', themeXml);
  zip.file('ppt/slideLayouts/slideLayout1.xml', layoutXml);
  zip.file(
    'ppt/slideLayouts/_rels/slideLayout1.xml.rels',
    `<?xml version="1.0"?>
<Relationships xmlns="${REL_NS}">
  <Relationship Id="rId1" Type="${REL('slideMaster')}" Target="../slideMasters/slideMaster1.xml"/>
</Relationships>`,
  );
  zip.file('ppt/slides/slide1.xml', pictureXml('rId2'));
  zip.file(
    'ppt/slides/_rels/slide1.xml.rels',
    `<?xml version="1.0"?>
<Relationships xmlns="${REL_NS}">
  <Relationship Id="rId1" Type="${REL('slideLayout')}" Target="../slideLayouts/slideLayout1.xml"/>
  <Relationship Id="rId2" Type="${REL('image')}" Target="../media/photo.png"/>
</Relationships>`,
  );
  zip.file('ppt/media/photo.png', PNG_BYTES);
  zip.file('ppt/media/bg.png', PNG_BYTES);
  zip.file('ppt/notesSlides/notesSlide1.xml', `<?xml version="1.0"?>
<p:notes xmlns:p="${P}" xmlns:a="${A}">
  <a:p><a:r><a:t>Emphasise the beta blocker contraindication</a:t></a:r></a:p>
  <a:p><a:r><a:t>1</a:t></a:r></a:p>
</p:notes>`);
  return zip.generateAsync({ type: 'uint8array' });
};

/**
 * Compatibility-heavy research slide matching what PowerPoint/WPS emit for a
 * body that contains native Office Math:
 *
 *   • the body group is wrapped by mc:AlternateContent,
 *   • the group intentionally has no a:xfrm (identity group),
 *   • the equation is another run-level AlternateContent with a14:m + OMML,
 *   • the slide-number placeholder has no geometry on the slide or layout and
 *     must inherit its lower-right transform from the master.
 */
export const buildPowerPointCompatibilityMathDeck = async () => {
  const zip = new JSZip();
  const MC = 'http://schemas.openxmlformats.org/markup-compatibility/2006';
  const A14 = 'http://schemas.microsoft.com/office/drawing/2010/main';
  const M = 'http://schemas.openxmlformats.org/officeDocument/2006/math';

  zip.file('ppt/presentation.xml', `<?xml version="1.0"?>
<p:presentation xmlns:p="${P}" xmlns:a="${A}" xmlns:r="${R}">
  <p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst>
  <p:sldSz cx="12192000" cy="6858000"/>
</p:presentation>`);
  zip.file('ppt/_rels/presentation.xml.rels', `<Relationships xmlns="${REL_NS}">
  <Relationship Id="rId1" Type="${REL('slide')}" Target="slides/slide1.xml"/>
</Relationships>`);

  zip.file('ppt/slideMasters/slideMaster1.xml', `<?xml version="1.0"?>
<p:sldMaster xmlns:p="${P}" xmlns:a="${A}" xmlns:r="${R}">
  <p:cSld><p:spTree>
    <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>
    <p:sp>
      <p:nvSpPr><p:cNvPr id="2" name="Title"/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
      <p:spPr><a:xfrm><a:off x="685800" y="342900"/><a:ext cx="10820400" cy="914400"/></a:xfrm></p:spPr>
      <p:txBody><a:bodyPr/><a:lstStyle/><a:p/></p:txBody>
    </p:sp>
    <p:sp>
      <p:nvSpPr><p:cNvPr id="3" name="Slide Number"/><p:nvPr><p:ph type="sldNum" idx="12"/></p:nvPr></p:nvSpPr>
      <p:spPr><a:xfrm><a:off x="10744200" y="6324600"/><a:ext cx="762000" cy="285750"/></a:xfrm></p:spPr>
      <p:txBody><a:bodyPr anchor="ctr"/><a:lstStyle/><a:p/></p:txBody>
    </p:sp>
  </p:spTree></p:cSld>
  <p:txStyles>
    <p:titleStyle><a:lvl1pPr><a:defRPr sz="3200" b="1"/></a:lvl1pPr></p:titleStyle>
    <p:bodyStyle><a:lvl1pPr><a:defRPr sz="2200"/></a:lvl1pPr></p:bodyStyle>
    <p:otherStyle><a:lvl1pPr algn="r"><a:defRPr sz="1000"><a:solidFill><a:srgbClr val="666666"/></a:solidFill></a:defRPr></a:lvl1pPr></p:otherStyle>
  </p:txStyles>
</p:sldMaster>`);
  zip.file('ppt/slideMasters/_rels/slideMaster1.xml.rels', `<Relationships xmlns="${REL_NS}">
  <Relationship Id="rId1" Type="${REL('slideLayout')}" Target="../slideLayouts/slideLayout1.xml"/>
</Relationships>`);

  zip.file('ppt/slideLayouts/slideLayout1.xml', `<?xml version="1.0"?>
<p:sldLayout xmlns:p="${P}" xmlns:a="${A}" xmlns:r="${R}">
  <p:cSld><p:spTree>
    <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>
    <p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p/></p:txBody></p:sp>
    <p:sp><p:nvSpPr><p:cNvPr id="3" name="Slide Number"/><p:nvPr><p:ph type="sldNum" idx="12"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p/></p:txBody></p:sp>
  </p:spTree></p:cSld>
</p:sldLayout>`);
  zip.file('ppt/slideLayouts/_rels/slideLayout1.xml.rels', `<Relationships xmlns="${REL_NS}">
  <Relationship Id="rId1" Type="${REL('slideMaster')}" Target="../slideMasters/slideMaster1.xml"/>
</Relationships>`);

  zip.file('ppt/slides/slide1.xml', `<?xml version="1.0"?>
<p:sld xmlns:p="${P}" xmlns:a="${A}" xmlns:r="${R}" xmlns:mc="${MC}" xmlns:a14="${A14}" xmlns:m="${M}" xmlns:u="urn:unsupported">
  <p:cSld><p:spTree>
    <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>
    <p:sp>
      <p:nvSpPr><p:cNvPr id="2" name="Title"/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
      <p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>Basic Sample Size Formulas</a:t></a:r></a:p></p:txBody>
    </p:sp>
    <mc:AlternateContent>
      <mc:Choice Requires="a14">
        <p:grpSp>
          <p:nvGrpSpPr><p:cNvPr id="4" name="Research body"/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>
          <p:sp>
            <p:nvSpPr><p:cNvPr id="5" name="Mean formula and explanation"/><p:nvPr/></p:nvSpPr>
            <p:spPr><a:xfrm><a:off x="800100" y="1485900"/><a:ext cx="10515600" cy="4114800"/></a:xfrm><a:prstGeom prst="rect"/><a:noFill/></p:spPr>
            <p:txBody><a:bodyPr/><a:lstStyle/>
              <a:p><a:r><a:rPr sz="2600" b="1"/><a:t>a) For Estimating a Mean:</a:t></a:r></a:p>
              <a:p><a:pPr algn="ctr"/><mc:AlternateContent>
                <mc:Choice Requires="a14"><a14:m><m:oMathPara><m:oMathParaPr><m:jc m:val="centerGroup"/></m:oMathParaPr><m:oMath>
                  <m:sSub><m:e><m:r><m:t>n</m:t></m:r></m:e><m:sub><m:r><m:t>o</m:t></m:r></m:sub></m:sSub>
                  <m:r><m:t>=</m:t></m:r>
                  <m:f><m:num><m:sSup><m:e><m:r><m:t>Z</m:t></m:r></m:e><m:sup><m:r><m:t>2</m:t></m:r></m:sup></m:sSup><m:r><m:t>×</m:t></m:r><m:sSup><m:e><m:r><m:t>σ</m:t></m:r></m:e><m:sup><m:r><m:t>2</m:t></m:r></m:sup></m:sSup></m:num><m:den><m:sSup><m:e><m:r><m:t>d</m:t></m:r></m:e><m:sup><m:r><m:t>2</m:t></m:r></m:sup></m:sSup></m:den></m:f>
                </m:oMath></m:oMathPara></a14:m></mc:Choice>
                <mc:Fallback><a:r><a:rPr sz="2600"/><a:t>nₒ = (Z² × σ²) ⁄ d²</a:t></a:r></mc:Fallback>
              </mc:AlternateContent></a:p>
              <a:p><a:r><a:rPr sz="2200"/><a:t>Where:</a:t></a:r></a:p>
              <a:p><a:pPr><a:buChar char="•"/></a:pPr><a:r><a:rPr sz="2200"/><a:t>Z = Z-value for desired confidence (e.g., 1.96 for 95%)</a:t></a:r></a:p>
              <a:p><a:pPr><a:buChar char="•"/></a:pPr><a:r><a:rPr sz="2200"/><a:t>σ = estimated standard deviation</a:t></a:r></a:p>
              <a:p><a:pPr><a:buChar char="•"/></a:pPr><a:r><a:rPr sz="2200"/><a:t>d = margin of error (precision)</a:t></a:r></a:p>
            </p:txBody>
          </p:sp>
        </p:grpSp>
      </mc:Choice>
      <mc:Fallback>
        <p:sp><p:nvSpPr><p:cNvPr id="5" name="Fallback preview"/><p:nvPr/></p:nvSpPr>
          <p:spPr><a:xfrm><a:off x="800100" y="1485900"/><a:ext cx="10515600" cy="4114800"/></a:xfrm><a:prstGeom prst="rect"/><a:blipFill><a:blip r:embed="rId2"/><a:stretch/></a:blipFill></p:spPr>
        </p:sp>
      </mc:Fallback>
    </mc:AlternateContent>
    <mc:AlternateContent>
      <mc:Choice Requires="u"><u:widget/></mc:Choice>
      <mc:Fallback>
        <p:sp><p:nvSpPr><p:cNvPr id="7" name="Compatibility image"/><p:nvPr/></p:nvSpPr>
          <p:spPr><a:xfrm><a:off x="11430000" y="457200"/><a:ext cx="457200" cy="457200"/></a:xfrm><a:prstGeom prst="ellipse"/><a:blipFill><a:blip r:embed="rId2"/><a:stretch/></a:blipFill></p:spPr>
        </p:sp>
      </mc:Fallback>
    </mc:AlternateContent>
    <p:sp>
      <p:nvSpPr><p:cNvPr id="6" name="Slide Number"/><p:nvPr><p:ph idx="12"/></p:nvPr></p:nvSpPr>
      <p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:fld id="{A1}" type="slidenum"><a:rPr/><a:t>11</a:t></a:fld></a:p></p:txBody>
    </p:sp>
  </p:spTree></p:cSld>
</p:sld>`);
  zip.file('ppt/slides/_rels/slide1.xml.rels', `<Relationships xmlns="${REL_NS}">
  <Relationship Id="rId1" Type="${REL('slideLayout')}" Target="../slideLayouts/slideLayout1.xml"/>
  <Relationship Id="rId2" Type="${REL('image')}" Target="../media/math-fallback.png"/>
</Relationships>`);
  zip.file('ppt/media/math-fallback.png', PNG_BYTES);
  return zip.generateAsync({ type: 'uint8array' });
};

/**
 * Realistic PowerPoint video placeholder: poster in p:blipFill plus either
 * the legacy a:videoFile relationship or the PowerPoint 2010+ p14:media form.
 * The tiny MP4 prefix is sufficient to verify byte-preserving local routing;
 * browser codec playback itself remains native.
 */
export const buildPowerPointVideoDeck = async ({ modern = false, linked = false } = {}) => {
  const zip = new JSZip();
  const clipRelationship = modern ? 'media' : 'video';
  const mediaMarker = modern
    ? `<p:extLst><p:ext uri="{DAA4B4D4-6D71-4841-9C94-3DE7FCFB9230}"><p14:media xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main" r:embed="rId3"/></p:ext></p:extLst>`
    : '<a:videoFile r:link="rId3"/>';

  zip.file('ppt/presentation.xml', `<?xml version="1.0"?>
<p:presentation xmlns:p="${P}" xmlns:a="${A}" xmlns:r="${R}">
  <p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst>
  <p:sldSz cx="9144000" cy="6858000"/>
</p:presentation>`);
  zip.file('ppt/_rels/presentation.xml.rels', `<Relationships xmlns="${REL_NS}">
  <Relationship Id="rId1" Type="${REL('slide')}" Target="slides/slide1.xml"/>
</Relationships>`);
  zip.file('ppt/slides/slide1.xml', `<?xml version="1.0"?>
<p:sld xmlns:p="${P}" xmlns:a="${A}" xmlns:r="${R}">
  <p:cSld><p:spTree>
    <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>
    <p:pic>
      <p:nvPicPr><p:cNvPr id="2" name="Training video"/><p:cNvPicPr/><p:nvPr>${mediaMarker}</p:nvPr></p:nvPicPr>
      <p:blipFill><a:blip r:embed="rId2"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>
      <p:spPr><a:xfrm><a:off x="914400" y="914400"/><a:ext cx="3657600" cy="2743200"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>
    </p:pic>
  </p:spTree></p:cSld>
</p:sld>`);
  zip.file('ppt/slides/_rels/slide1.xml.rels', `<Relationships xmlns="${REL_NS}">
  <Relationship Id="rId2" Type="${REL('image')}" Target="../media/poster1.png"/>
  <Relationship Id="rId3" Type="${REL(clipRelationship)}" Target="${linked ? 'https://media.example/training.mp4' : '../media/clip1.mp4'}"${linked ? ' TargetMode="External"' : ''}/>
</Relationships>`);
  zip.file('ppt/media/poster1.png', PNG_BYTES);
  if (!linked) {
    zip.file('ppt/media/clip1.mp4', new Uint8Array([
      0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70,
      0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00,
      0x69, 0x73, 0x6f, 0x6d, 0x6d, 0x70, 0x34, 0x32,
    ]));
  }
  return zip.generateAsync({ type: 'uint8array' });
};
