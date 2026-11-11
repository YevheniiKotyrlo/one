import { One } from 'one'
import { Text, View } from 'react-native'

const identifier = 'repro-force-stop'

One.Notifications.getAllScheduled()
  .then(async (scheduled) => {
    const listed = scheduled.find((request) => request.identifier === identifier)
    if (listed?.trigger.type === 'date') {
      console.log(`repro-listed ${identifier} at ${listed.trigger.date}`)
      return
    }
    const date = Date.now() + 60 * 1000
    await One.Notifications.schedule({
      identifier,
      content: { title: 'Repro' },
      trigger: { type: 'date', date },
    })
    console.log(`repro-scheduled ${identifier} at ${date}`)
  })
  .catch((error) => console.log(`repro-failed ${error}`))

export default function Index() {
  return (
    <View
      style={{
        flex: 1,
        alignSelf: 'center',
        justifyContent: 'center',
        alignItems: 'center',
        minHeight: '100%',
      }}
    >
      <Text>Schedules a notification a minute ahead unless getAllScheduled lists it</Text>
    </View>
  )
}
