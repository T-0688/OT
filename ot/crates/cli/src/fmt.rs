//! Tiny table renderer that understands double-width CJK characters, so Chinese
//! titles do not break column alignment.

fn is_wide(c: char) -> bool {
    matches!(c as u32,
        0x1100..=0x115F
        | 0x2E80..=0x303E
        | 0x3041..=0x33FF
        | 0x3400..=0x4DBF
        | 0x4E00..=0x9FFF
        | 0xA000..=0xA4CF
        | 0xAC00..=0xD7A3
        | 0xF900..=0xFAFF
        | 0xFE30..=0xFE6F
        | 0xFF00..=0xFF60
        | 0xFFE0..=0xFFE6
        | 0x1F300..=0x1FAFF
        | 0x20000..=0x3FFFD)
}

pub fn dw(s: &str) -> usize {
    s.chars().map(|c| if is_wide(c) { 2 } else { 1 }).sum()
}

pub fn pad(s: &str, width: usize) -> String {
    let w = dw(s);
    if w >= width {
        s.to_string()
    } else {
        format!("{s}{}", " ".repeat(width - w))
    }
}

pub fn print_table(headers: &[&str], rows: &[Vec<String>]) {
    if rows.is_empty() {
        return;
    }
    let cols = headers.len();
    let mut widths = vec![0usize; cols];
    for (i, h) in headers.iter().enumerate() {
        widths[i] = dw(h);
    }
    for row in rows {
        for (i, cell) in row.iter().enumerate().take(cols) {
            widths[i] = widths[i].max(dw(cell));
        }
    }
    let mut head = String::new();
    for (i, h) in headers.iter().enumerate() {
        if i + 1 == cols {
            head.push_str(h);
        } else {
            head.push_str(&pad(h, widths[i]));
            head.push_str("  ");
        }
    }
    println!("{head}");
    for row in rows {
        let mut line = String::new();
        for i in 0..cols {
            let cell = row.get(i).map(String::as_str).unwrap_or("");
            if i + 1 == cols {
                line.push_str(cell);
            } else {
                line.push_str(&pad(cell, widths[i]));
                line.push_str("  ");
            }
        }
        println!("{}", line.trim_end());
    }
}
