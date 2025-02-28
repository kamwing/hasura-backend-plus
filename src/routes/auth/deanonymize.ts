import { Response } from 'express'
import { APPLICATION, AUTHENTICATION, REGISTRATION } from "@shared/config";
import { accountIsAnonymous, accountWithEmailExists, asyncWrapper, checkHibp, hashPassword, deanonymizeAccount as deanonymizeAccountHelper, selectAccountByUserId } from "@shared/helpers";
import { deanonymizeSchema } from '@shared/validation';
import { RequestExtended } from '@shared/types';
import { request } from '@shared/request';
import { changeEmailByUserId, changePasswordHashByUserId, deactivateAccount, setNewTicket } from '@shared/queries';
import { emailClient } from '@shared/email';
import { v4 as uuid4 } from 'uuid'

async function deanonymizeAccount(req: RequestExtended, res: Response): Promise<unknown> {
  const body = req.body

  if(!AUTHENTICATION.ANONYMOUS_USERS_ENABLE) {
    return res.boom.badImplementation(`Please set the ANONYMOUS_USERS_ENABLE env variable to true to use the auth/deanonymize route.`)
  }

  if (!req.permission_variables || !await accountIsAnonymous(req.permission_variables['user-id'])) {
    return res.boom.unauthorized('Unable to deanonymize account')
  }

  const {
    email,
    password,
  } = await deanonymizeSchema.validateAsync(body)

  try {
    await checkHibp(password)
  } catch (err) {
    return res.boom.badRequest(err.message)
  }

  let passwordHash: string
  try {
    passwordHash = await hashPassword(password)
  } catch (err) {
    return res.boom.internal(err.message)
  }

  if (await accountWithEmailExists(email)) {
    return res.boom.badRequest('Cannot use this email.')
  }

  const user_id = req.permission_variables['user-id']

  await request(changeEmailByUserId, {
    user_id,
    new_email: email
  })

  await request(changePasswordHashByUserId, {
    user_id,
    new_password_hash: passwordHash
  })

  if(REGISTRATION.AUTO_ACTIVATE_NEW_USERS) {
    await deanonymizeAccountHelper(
      await selectAccountByUserId(user_id).then(acc => acc.id),
    )
  } else {
    const ticket = uuid4() // will be decrypted on the auth/activate call
    const ticket_expires_at = new Date(+new Date() + 60 * 60 * 1000) // active for 60 minutes

    await request(setNewTicket, {
      user_id,
      ticket,
      ticket_expires_at
    })

    await request(deactivateAccount, {
      user_id
    })

    const account = await selectAccountByUserId(user_id)

    await emailClient.send({
      template: 'activate-account',
      message: {
        to: email,
        headers: {
          'x-ticket': {
            prepared: true,
            value: ticket
          }
        }
      },
      locals: {
        display_name: email,
        ticket,
        url: APPLICATION.SERVER_URL,
        locale: account.locale
      }
    })
  }

  return res.status(204).send()
}

export default asyncWrapper(deanonymizeAccount)
