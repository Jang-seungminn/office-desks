fn main() {
    // WebDist embeds web/dist (rust-embed); rebuild when it changes or appears.
    println!("cargo:rerun-if-changed=../../web/dist");
}
