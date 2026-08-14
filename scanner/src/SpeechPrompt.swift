import Foundation

/* The words the radio actually uses, handed to Whisper before it listens.
 *
 * WHY THIS EXISTS. Whisper decodes with a language model prior, and on vocoded
 * trunked radio the acoustics are so degraded that the prior does most of the
 * work. With no context it reaches for whatever is likely in general English,
 * which is how "Boylston" came out as "Oilston", how "Alpha Tango" came out as
 * "Alfalfa", and how an entire fatal stabbing at South Station transcribed
 * without ever containing the words South Station or stabbing.
 *
 * An initial prompt shifts that prior. It does not teach the model anything;
 * it tells it what kind of conversation this is, so the proper nouns a
 * newsroom needs stop losing to ordinary words that sound similar.
 *
 * THE LENGTH IS THE HARD CONSTRAINT, and the reason this file is a curated
 * list rather than a gazetteer dump. Whisper truncates the initial prompt to
 * half its text context, 224 tokens, and it takes the LAST tokens when it
 * overflows. A long prompt does not degrade gracefully, it silently discards
 * the front of itself. So this stays well under that, and every entry has to
 * earn its place by being both frequent on Boston radio and easy to mishear.
 *
 * What earns a slot, in order: the words that decide whether something is
 * news, the place names a reporter would search for, and the phonetic
 * alphabet and apparatus prefixes that make up most unit designators.
 */
enum SpeechPrompt {
    static let text: String = [
        "Boston police, fire, EMS and MBTA Transit Police radio dispatch.",
        "Terms: shots fired, shooting, stabbing, stabbed, victim, unresponsive,",
        "cardiac arrest, priority one, working fire, structure fire, multiple alarm,",
        "person down, fatal, medical examiner, hazmat, pursuit, on scene, en route.",
        "Places: South Station, North Station, Back Bay, TD Garden, Fenway Park,",
        "Logan Airport, Downtown Crossing, Government Center, Dorchester, Roxbury,",
        "Mattapan, Jamaica Plain, South Boston, East Boston, Charlestown, Allston,",
        "Brighton, Hyde Park, Roslindale, Seaport, Beacon Hill, Boylston Street,",
        "Tremont Street, Massachusetts Avenue, Blue Hill Avenue, Dorchester Avenue.",
        "Units: Engine, Ladder, Squad, Rescue, Ambulance, Division, Alpha, Bravo,",
        "Charlie, Delta, Echo, Foxtrot, Kilo, Tango, Victor, Zulu.",
    ].joined(separator: " ")
}
