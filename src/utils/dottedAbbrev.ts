/** Merge ONLY isolated single-character dotted abbreviations ("P.D." -> "pd").
 *  A blanket letter/digit dot-merge destroyed release names: "Moana.2.2024.UHD"
 *  collapsed into "moana22024" and "The.Hobbit.The.Battle.of.the.Five.Armies..."
 *  into one mega-token, so a request titled "Moana 2" stopped matching its own
 *  torrent and the startup stale-RC cleanup deleted live links on a fabricated
 *  "title mismatch". A dot may only join two characters when BOTH are
 *  single-character tokens bounded by separators (start/end of the string or a
 *  non-alphanumeric symbol), so "chicago.p.d" -> "chicago pd" while every real
 *  release-name word boundary ("Moana.2.2024", "The.Hobbit.The.Battle",
 *  "DDP5.1.H.264") is preserved. Repeats to a fixpoint so "p.d.n" -> "pdn".
 *  Apply on both sides of a compare so the treatment is symmetric. */
export function mergeDottedAbbreviations(s: string): string {
  let out = s;
  let prev: string;
  do {
    prev = out;
    out = out.replace(/(^|[^a-z0-9])([a-z0-9])\.([a-z0-9])(?=$|[^a-z0-9])/gi, "$1$2$3");
  } while (out !== prev);
  return out;
}