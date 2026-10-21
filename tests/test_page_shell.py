from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_pdf_library_is_local_and_camera_is_not_forced():
    html = (ROOT / "static" / "index.html").read_text(encoding="utf-8")
    library = ROOT / "static" / "jspdf.umd.min.js"
    assert library.is_file()
    assert library.stat().st_size > 100000
    assert 'src="/assets/jspdf.umd.min.js"' in html
    assert "cdnjs.cloudflare.com/ajax/libs/jspdf" not in html
    assert "capture=" not in html
    assert 'accept="image/*"' in html
