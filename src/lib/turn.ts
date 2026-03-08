const fetch = require('node-fetch');

const TURN_KEY_ID = 'a11e40ec8d548f278468046b27538534'; // Replace with your TURN Key ID
// const TURN_KEY_API_TOKEN = ''; // Replace with your API token

const url = `https://rtc.live.cloudflare.com/v1/turn/keys/${TURN_KEY_ID}/credentials/generate-ice-servers`;

const body = JSON.stringify({
	ttl: 86400,
});

interface TurnResponse {
	urls: String[];
	username: String;
	credential: String;
}

// TODO: construct this at init and inject env.TURN_KEY in it so it always has it, rather than passing it in.
export class TurnHelper {
	/**
	 *
	 * @param message
	 */
	public static async generate(TURN_KEY_API_TOKEN: String): Promise<TurnResponse | null> {
		const fetchTurnCredentials = await fetch(url, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${TURN_KEY_API_TOKEN}`,
				'Content-Type': 'application/json',
			},
			body: body,
		})
			.then((response: Response) => response.json())
			.then((data: TurnResponse) => data)
			.catch((_error: Error) => null);

		return fetchTurnCredentials;
	}
}
