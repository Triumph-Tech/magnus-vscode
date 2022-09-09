import axios from "axios";

/**
 * Handles loading and caching of remote icon images.
 */
export class IconCache {
    private iconData: Record<string, string | null> = {};

    /**
     * Gets the icon from the specified URI. If it is in cache it will be returned
     * immediately, otherwise a promise will be returned.
     *
     * @param uri The URI that contains the image to use for the icon.
     * @returns A data URI encoded representation of the image or null if it was not found.
     */
    public async getIcon(uri: string): Promise<string | null> {
        let icon = this.iconData[uri];

        if (icon !== undefined) {
            return icon;
        }

        const response = await axios.get<ArrayBuffer>(uri, {
            timeout: 10000
        });

        if (response.status !== 200) {
            this.iconData[uri] = null;
            return null;
        }

        const base64data = Buffer.from(response.data).toString("base64");
        icon = `data:image/svg+xml;base64,${base64data}`;

        this.iconData[uri] = icon;

        return icon;
    }
}
