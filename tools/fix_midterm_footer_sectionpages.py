from __future__ import annotations

from pathlib import Path
from tempfile import NamedTemporaryFile
from zipfile import ZIP_DEFLATED, ZipFile

from lxml import etree


DOCX = Path("/Users/renke/毕设/中期答辩/任科中期报告_0621_最新.docx")
W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
NS = {"w": W_NS}


def main() -> None:
    with NamedTemporaryFile(delete=False, suffix=".docx") as tmp:
        tmp_path = Path(tmp.name)

    with ZipFile(DOCX, "r") as zin, ZipFile(tmp_path, "w", ZIP_DEFLATED) as zout:
        for item in zin.infolist():
            data = zin.read(item.filename)
            if item.filename == "word/footer4.xml":
                root = etree.fromstring(data)
                instr_nodes = root.xpath(".//w:instrText[contains(., 'SECTIONPAGES')]", namespaces=NS)
                for instr in instr_nodes:
                    # Cached result is between fldChar separate and fldChar end.
                    parent = instr.getparent().getparent()
                    seen_separate = False
                    for child in list(parent):
                        fld_chars = child.xpath(".//w:fldChar", namespaces=NS)
                        if fld_chars:
                            fld_type = fld_chars[0].get(f"{{{W_NS}}}fldCharType")
                            if fld_type == "separate":
                                seen_separate = True
                                continue
                            if fld_type == "end" and seen_separate:
                                break
                        if seen_separate:
                            texts = child.xpath(".//w:t", namespaces=NS)
                            for t in texts:
                                t.text = "44"
                data = etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True)
            elif item.filename == "word/settings.xml":
                root = etree.fromstring(data)
                if not root.xpath("./w:updateFields", namespaces=NS):
                    update = etree.Element(f"{{{W_NS}}}updateFields")
                    update.set(f"{{{W_NS}}}val", "true")
                    root.insert(0, update)
                data = etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True)
            zout.writestr(item, data)

    tmp_path.replace(DOCX)
    print("updated footer SECTIONPAGES cache to 44 and enabled updateFields")


if __name__ == "__main__":
    main()
