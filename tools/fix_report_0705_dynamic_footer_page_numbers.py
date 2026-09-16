from __future__ import annotations

from pathlib import Path
from tempfile import NamedTemporaryFile
from zipfile import ZIP_DEFLATED, ZipFile

from lxml import etree


DOCX = Path("/Users/renke/毕设/中期答辩/任科中期报告_0701_新框架版.docx")
W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
NS = {"w": W_NS}


def w_el(tag: str, text: str | None = None, **attrs: str) -> etree._Element:
    node = etree.Element(f"{{{W_NS}}}{tag}")
    for key, value in attrs.items():
        node.set(f"{{{W_NS}}}{key}", value)
    if text is not None:
        node.text = text
    return node


def run_text(text: str, space: bool = False) -> etree._Element:
    run = w_el("r")
    t = w_el("t", text)
    if space:
        t.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")
    run.append(t)
    return run


def field_run(instr: str, cached: str) -> list[etree._Element]:
    begin = w_el("r")
    begin.append(w_el("fldChar", fldCharType="begin"))

    instr_run = w_el("r")
    instr_text = w_el("instrText", f" {instr} ")
    instr_text.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")
    instr_run.append(instr_text)

    separate = w_el("r")
    separate.append(w_el("fldChar", fldCharType="separate"))

    cached_run = run_text(cached)

    end = w_el("r")
    end.append(w_el("fldChar", fldCharType="end"))
    return [begin, instr_run, separate, cached_run, end]


def rewrite_footer5(data: bytes) -> bytes:
    root = etree.fromstring(data)
    paragraphs = root.xpath("./w:p", namespaces=NS)
    if not paragraphs:
        paragraph = w_el("p")
        root.append(paragraph)
    else:
        paragraph = paragraphs[0]

    for child in list(paragraph):
        if child.tag != f"{{{W_NS}}}pPr":
            paragraph.remove(child)

    paragraph.extend(field_run("PAGE", "2"))
    paragraph.append(run_text(" / ", space=True))
    paragraph.extend(field_run("NUMPAGES", "56"))
    return etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True)


def ensure_update_fields(data: bytes) -> bytes:
    root = etree.fromstring(data)
    existing = root.xpath("./w:updateFields", namespaces=NS)
    if existing:
        existing[0].set(f"{{{W_NS}}}val", "true")
    else:
        update = w_el("updateFields", val="true")
        root.insert(0, update)
    return etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True)


def normalize_section_page_numbers(data: bytes) -> bytes:
    root = etree.fromstring(data)
    sections = root.xpath(".//w:sectPr", namespaces=NS)
    for index, section in enumerate(sections):
        pg_num = section.find("w:pgNumType", NS)
        if index == 0:
            if pg_num is None:
                pg_num = w_el("pgNumType")
                section.insert(0, pg_num)
            pg_num.set(f"{{{W_NS}}}start", "1")
        elif pg_num is not None:
            section.remove(pg_num)
    return etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True)


def main() -> None:
    with NamedTemporaryFile(delete=False, suffix=".docx") as tmp:
        tmp_path = Path(tmp.name)

    with ZipFile(DOCX, "r") as zin, ZipFile(tmp_path, "w", ZIP_DEFLATED) as zout:
        for item in zin.infolist():
            data = zin.read(item.filename)
            if item.filename == "word/footer5.xml":
                data = rewrite_footer5(data)
            elif item.filename == "word/settings.xml":
                data = ensure_update_fields(data)
            elif item.filename == "word/document.xml":
                data = normalize_section_page_numbers(data)
            zout.writestr(item, data)

    tmp_path.replace(DOCX)
    print(DOCX)


if __name__ == "__main__":
    main()
